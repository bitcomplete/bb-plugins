/**
 * End-to-end provisioning against real git repositories.
 *
 * Milestone 1 is the load-bearing one — it is where the sandbox story, the
 * alternates story and the commit story are either true or not — and none of
 * those can be checked by parsing strings. These build actual repos on disk
 * and assert the properties the design depends on.
 */
import { access, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheDefaultBranch, cachePathFor, cacheStatus, ensureCache, findMirror } from "./cache.js";
import { workspaceRepoSchema } from "./contract.js";
import { repoChanges, repoLiveStatus, filePatch } from "./diff.js";
import { git, gitIn, gitLine } from "./git.js";
import {
  bootstrapProjectSource,
  cloneProjectSource,
  defaultProjectSourcePath,
  pushGuidance,
  readReposJson,
  writeReposJson,
} from "./source.js";
import { EMPTY_REPOS, parseReposFile } from "./repos.js";
import { provisionWorkspace, removeWorkspace, workspaceRoot } from "./workspace.js";

let scratch: string;
let dataDir: string;

/** A repo standing in for a network remote. */
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

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "multi-repo-e2e-"));
  dataDir = path.join(scratch, "host-data");
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("the object cache", () => {
  it("clones a bare, self-contained mirror and records when it fetched", async () => {
    const remote = await makeRemote("alpha");
    const entry = await ensureCache({ dataDir, url: remote, mirrors: [], fetchTtlMs: 0 });
    expect(await gitLine(entry.path, ["rev-parse", "--is-bare-repository"])).toBe("true");
    expect(entry.fetchedAt).not.toBeNull();
    // Self-contained: no alternates pointing at anyone else's object store.
    expect(await exists(path.join(entry.path, "objects", "info", "alternates"))).toBe(false);
  });

  it("disables automatic gc, because borrowing clones are invisible to it", async () => {
    const remote = await makeRemote("alpha");
    const entry = await ensureCache({ dataDir, url: remote, mirrors: [], fetchTtlMs: 0 });
    expect(await gitLine(entry.path, ["config", "--get", "gc.auto"])).toBe("0");
    expect(await gitLine(entry.path, ["config", "--get", "gc.pruneExpire"])).toBe("never");
  });

  it("sets a fetch refspec, which clone --bare deliberately omits", async () => {
    const remote = await makeRemote("alpha");
    const entry = await ensureCache({ dataDir, url: remote, mirrors: [], fetchTtlMs: 0 });
    // Without this a plain `git fetch` in the cache would update nothing.
    expect(await gitLine(entry.path, ["config", "--get", "remote.origin.fetch"])).toBe(
      "+refs/heads/*:refs/heads/*",
    );
  });

  it("picks up new commits on a later fetch", async () => {
    const remote = await makeRemote("alpha");
    await ensureCache({ dataDir, url: remote, mirrors: [], fetchTtlMs: 0 });
    await writeFile(path.join(remote, "second.txt"), "two\n", "utf8");
    await gitIn(remote, ["add", "-A"]);
    await gitIn(remote, ["commit", "--quiet", "-m", "second"]);
    const entry = await ensureCache({ dataDir, url: remote, mirrors: [], fetchTtlMs: 0 });
    const log = await gitLine(entry.path, ["log", "--oneline", "main"]);
    expect(log).toContain("second");
  });

  it("skips the fetch while the entry is still fresh", async () => {
    const remote = await makeRemote("alpha");
    const first = await ensureCache({ dataDir, url: remote, mirrors: [], fetchTtlMs: 60_000 });
    const second = await ensureCache({ dataDir, url: remote, mirrors: [], fetchTtlMs: 60_000 });
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });

  it("seeds from a local mirror and then still fetches the real remote", async () => {
    const remote = await makeRemote("alpha");
    // A checkout on this machine that is one commit behind the remote.
    const localClone = path.join(scratch, "checkouts", "alpha");
    await mkdir(path.dirname(localClone), { recursive: true });
    await git(["clone", "--quiet", remote, localClone]);
    await writeFile(path.join(remote, "later.txt"), "later\n", "utf8");
    await gitIn(remote, ["add", "-A"]);
    await gitIn(remote, ["commit", "--quiet", "-m", "later"]);

    const entry = await ensureCache({
      dataDir,
      url: remote,
      mirrors: [{ path: localClone, url: remote }],
      fetchTtlMs: 0,
    });
    // The mirror is a head start on objects, never an answer about refs.
    expect(await gitLine(entry.path, ["log", "--oneline", "main"])).toContain("later");
    expect(await exists(path.join(entry.path, "objects", "info", "alternates"))).toBe(false);
  });

  it("recovers from a directory left behind by an interrupted clone", async () => {
    const remote = await makeRemote("alpha");
    const { path: cachePath } = cachePathFor(dataDir, remote);
    await mkdir(cachePath, { recursive: true });
    await writeFile(path.join(cachePath, "junk"), "debris", "utf8");
    const entry = await ensureCache({ dataDir, url: remote, mirrors: [], fetchTtlMs: 0 });
    expect(await gitLine(entry.path, ["rev-parse", "--is-bare-repository"])).toBe("true");
  });

  it("serializes concurrent callers onto one clone", async () => {
    const remote = await makeRemote("alpha");
    const entries = await Promise.all(
      Array.from({ length: 4 }, () => ensureCache({ dataDir, url: remote, mirrors: [], fetchTtlMs: 60_000 })),
    );
    const keys = new Set(entries.map((entry) => entry.key));
    expect(keys.size).toBe(1);
    expect(await gitLine(entries[0].path, ["rev-parse", "--is-bare-repository"])).toBe("true");
  });

  it("reports the default branch even when it is not called main", async () => {
    const remote = await makeRemote("trunked", "trunk");
    const entry = await ensureCache({ dataDir, url: remote, mirrors: [], fetchTtlMs: 0 });
    expect(await cacheDefaultBranch(entry.path)).toBe("trunk");
  });

  it("reports an absent entry rather than creating one", async () => {
    const [entry] = await cacheStatus(dataDir, ["https://example.invalid/never-cloned"]);
    expect(entry.present).toBe(false);
    expect(entry.fetchedAt).toBeNull();
  });

  it("matches a mirror across equivalent url spellings", () => {
    const mirrors = [{ path: "/src/repo", url: "https://github.com/you/repo" }];
    expect(findMirror("git@github.com:you/repo.git", mirrors)).toBe("/src/repo");
    expect(findMirror("https://github.com/them/repo", mirrors)).toBeNull();
  });
});

describe("provisioning a workspace", () => {
  async function setup() {
    const alpha = await makeRemote("alpha");
    const beta = await makeRemote("beta");
    const projectSource = path.join(scratch, "project-source");
    await mkdir(projectSource, { recursive: true });
    await bootstrapProjectSource(projectSource, EMPTY_REPOS);
    return { alpha, beta, projectSource };
  }

  it("produces a plain directory root that is not a git repo", async () => {
    const { alpha, projectSource } = await setup();
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: projectSource,
      repos: [{ dir: "alpha", url: alpha, branch: null }],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    // The single most important invariant: a `.git` here would flip the
    // environment into git mode and show a misleading native diff tab.
    expect(await exists(path.join(result.root, ".git"))).toBe(false);
    expect(result.root).toBe(workspaceRoot(dataDir, "thread1"));
  });

  it("gives every repo its own .git inside cwd, so commits are not sandboxed out", async () => {
    const { alpha, projectSource } = await setup();
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: projectSource,
      repos: [{ dir: "alpha", url: alpha, branch: null }],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    const repo = result.repos.find((entry) => entry.dir === "alpha");
    expect(repo?.status).toBe("ready");
    expect(await exists(path.join(repo!.path, ".git"))).toBe(true);

    // The whole reason these are clones and not worktrees: a commit must work.
    await gitIn(repo!.path, ["config", "user.email", "test@example.invalid"]);
    await gitIn(repo!.path, ["config", "user.name", "Test"]);
    await writeFile(path.join(repo!.path, "new.txt"), "hello\n", "utf8");
    await gitIn(repo!.path, ["add", "-A"]);
    const committed = await gitIn(repo!.path, ["commit", "--quiet", "-m", "agent work"]);
    expect(committed.code).toBe(0);
  });

  it("borrows objects from the cache through alternates", async () => {
    const { alpha, projectSource } = await setup();
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: projectSource,
      repos: [{ dir: "alpha", url: alpha, branch: null }],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    const repo = result.repos.find((entry) => entry.dir === "alpha")!;
    const alternates = await readFile(
      path.join(repo.path, ".git", "objects", "info", "alternates"),
      "utf8",
    );
    expect(alternates.trim()).toBe(path.join(cachePathFor(dataDir, alpha).path, "objects"));
  });

  it("repoints origin at the real remote, never the cache", async () => {
    const { alpha, projectSource } = await setup();
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: projectSource,
      repos: [{ dir: "alpha", url: alpha, branch: null }],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    const repo = result.repos.find((entry) => entry.dir === "alpha")!;
    // An agent that pushed to the cache would write into every other
    // workspace's object store.
    expect(await gitLine(repo.path, ["config", "--get", "remote.origin.url"])).toBe(alpha);
  });

  it("puts every work repo on the same thread branch", async () => {
    const { alpha, beta, projectSource } = await setup();
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: projectSource,
      repos: [
        { dir: "alpha", url: alpha, branch: null },
        { dir: "beta", url: beta, branch: null },
      ],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    for (const dir of ["alpha", "beta"]) {
      const repo = result.repos.find((entry) => entry.dir === dir)!;
      expect(repo.branch).toBe("dylan/work");
      expect(await gitLine(repo.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("dylan/work");
    }
  });

  it("clones .bb and leaves it on its own default branch", async () => {
    const { alpha, projectSource } = await setup();
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: projectSource,
      repos: [{ dir: "alpha", url: alpha, branch: null }],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    const source = result.repos.find((entry) => entry.dir === ".bb")!;
    expect(source.status).toBe("ready");
    expect(source.branch).not.toBe("dylan/work");
    expect(await exists(path.join(source.path, "AGENTS.md"))).toBe(true);
    expect(await exists(path.join(source.path, "repos.json"))).toBe(true);
  });

  it("honours an explicit base branch and fails the repo by name when it is absent", async () => {
    const { alpha, projectSource } = await setup();
    await gitIn(alpha, ["branch", "release"]);
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: projectSource,
      repos: [
        { dir: "ok", url: alpha, branch: "release" },
        { dir: "bad", url: alpha, branch: "nonexistent" },
      ],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    expect(result.repos.find((entry) => entry.dir === "ok")?.baseBranch).toBe("release");
    const bad = result.repos.find((entry) => entry.dir === "bad")!;
    expect(bad.status).toBe("failed");
    expect(bad.message).toContain("nonexistent");
  });

  it("keeps the other repos when one fails, rather than failing the thread", async () => {
    const { alpha, projectSource } = await setup();
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: projectSource,
      repos: [
        { dir: "alpha", url: alpha, branch: null },
        { dir: "ghost", url: path.join(scratch, "does-not-exist"), branch: null },
      ],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    expect(result.repos.find((entry) => entry.dir === "alpha")?.status).toBe("ready");
    expect(result.repos.find((entry) => entry.dir === "ghost")?.status).toBe("failed");
  });

  it("is idempotent for a path key, as core requires after a restart", async () => {
    const { alpha, projectSource } = await setup();
    const args = {
      dataDir,
      pathKey: "thread1",
      projectSourcePath: projectSource,
      repos: [{ dir: "alpha", url: alpha, branch: null }],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    };
    const first = await provisionWorkspace(args);
    const repo = first.repos.find((entry) => entry.dir === "alpha")!;
    await writeFile(path.join(repo.path, "agent-work.txt"), "in progress\n", "utf8");

    const second = await provisionWorkspace(args);
    expect(second.repos.find((entry) => entry.dir === "alpha")?.status).toBe("ready");
    // A completed repo is left alone, so a re-entered create does not discard
    // work the agent already did.
    expect(await exists(path.join(repo.path, "agent-work.txt"))).toBe(true);
  });

  it("falls back to a different branch name when the thread's name is taken", async () => {
    const { alpha, projectSource } = await setup();
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: projectSource,
      // The base branch and the thread branch collide.
      repos: [{ dir: "alpha", url: alpha, branch: "main" }],
      branchName: "main",
      fetchTtlMs: 0,
      mirrors: [],
    });
    const repo = result.repos.find((entry) => entry.dir === "alpha")!;
    expect(repo.status).toBe("ready");
    expect(repo.branch).toBe("main-alpha");
  });
});

describe("removing a workspace", () => {
  it("removes the root and its completion markers", async () => {
    const alpha = await makeRemote("alpha");
    const projectSource = path.join(scratch, "project-source");
    await mkdir(projectSource, { recursive: true });
    await bootstrapProjectSource(projectSource, EMPTY_REPOS);
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: projectSource,
      repos: [{ dir: "alpha", url: alpha, branch: null }],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    const removed = await removeWorkspace({ dataDir, pathKey: "thread1", path: result.root });
    expect(removed.removed).toBe(true);
    expect(await exists(result.root)).toBe(false);
    // The cache is shared with every other workspace and must survive.
    expect(await exists(cachePathFor(dataDir, alpha).path)).toBe(true);
  });

  it("refuses a path it did not create", async () => {
    const stranger = path.join(scratch, "not-ours");
    await mkdir(stranger, { recursive: true });
    await expect(removeWorkspace({ dataDir, pathKey: "thread1", path: stranger })).rejects.toThrow(/Refusing/u);
    expect(await exists(stranger)).toBe(true);
  });

  it("reports nothing removed for a workspace that was never created", async () => {
    const removed = await removeWorkspace({ dataDir, pathKey: "never", path: null });
    expect(removed.removed).toBe(false);
  });
});

describe("the project source", () => {
  it("initializes an empty directory with a repo set and seeded guidance", async () => {
    const dir = path.join(scratch, "fresh");
    await mkdir(dir, { recursive: true });
    const result = await bootstrapProjectSource(dir, EMPTY_REPOS);
    expect(result.bootstrapped).toBe(true);
    expect(await exists(path.join(dir, ".git"))).toBe(true);
    const agents = await readFile(path.join(dir, "AGENTS.md"), "utf8");
    // Agents will not use `.bb` unless the seed explains what it is for.
    // Matched loosely because the seed is hard-wrapped prose.
    expect(agents).toMatch(/shared by every\s+thread in this project/u);
    expect(agents).toMatch(/durable cross-repo\s+knowledge/u);
    expect(parseReposFile((await readReposJson(dir))!).ok).toBe(true);
    expect(await gitLine(dir, ["rev-parse", "HEAD"])).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("leaves an existing repo alone", async () => {
    const dir = await makeRemote("already-a-repo");
    await writeFile(path.join(dir, "AGENTS.md"), "mine\n", "utf8");
    const result = await bootstrapProjectSource(dir, EMPTY_REPOS);
    expect(result.bootstrapped).toBe(false);
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe("mine\n");
  });

  it("commits an updated repo set", async () => {
    const dir = path.join(scratch, "fresh");
    await mkdir(dir, { recursive: true });
    await bootstrapProjectSource(dir, EMPTY_REPOS);
    const before = await gitLine(dir, ["rev-parse", "HEAD"]);
    const written = await writeReposJson(
      dir,
      `{"version":1,"repos":[{"dir":"a","url":"https://example.com/a"}]}\n`,
      "Add a",
    );
    expect(written.committed).toBe(true);
    expect(await gitLine(dir, ["rev-parse", "HEAD"])).not.toBe(before);
  });

  it("publishes workspace .bb commits back to the canonical checkout as a branch", async () => {
    const canonical = path.join(scratch, "canonical");
    await mkdir(canonical, { recursive: true });
    await bootstrapProjectSource(canonical, EMPTY_REPOS);
    const workspaceBb = path.join(scratch, "workspace-bb");
    await git(["clone", "--quiet", canonical, workspaceBb]);
    await gitIn(workspaceBb, ["config", "user.email", "test@example.invalid"]);
    await gitIn(workspaceBb, ["config", "user.name", "Test"]);
    await writeFile(path.join(workspaceBb, "AGENTS.md"), "learned something\n", "utf8");
    await gitIn(workspaceBb, ["add", "-A"]);
    await gitIn(workspaceBb, ["commit", "--quiet", "-m", "record knowledge"]);

    const result = await pushGuidance(canonical, workspaceBb, "thr_abc123");
    expect(result.ok).toBe(true);
    expect(result.ref).toBe("refs/heads/guidance-thr_abc123");
    // It lands on a branch, not on the checked-out one: that is what sidesteps
    // receive.denyCurrentBranch and leaves something reviewable.
    const branchHead = await gitLine(canonical, ["rev-parse", "guidance-thr_abc123"]);
    expect(branchHead).toBe(await gitLine(workspaceBb, ["rev-parse", "HEAD"]));
    expect(await readFile(path.join(canonical, "AGENTS.md"), "utf8")).not.toBe("learned something\n");
  });
});

describe("diff data", () => {
  async function workspaceWithChanges() {
    const alpha = await makeRemote("alpha");
    const projectSource = path.join(scratch, "project-source");
    await mkdir(projectSource, { recursive: true });
    await bootstrapProjectSource(projectSource, EMPTY_REPOS);
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: projectSource,
      repos: [{ dir: "alpha", url: alpha, branch: null }],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    const repo = result.repos.find((entry) => entry.dir === "alpha")!;
    await gitIn(repo.path, ["config", "user.email", "test@example.invalid"]);
    await gitIn(repo.path, ["config", "user.name", "Test"]);
    return { repo, alpha };
  }

  it("reports committed, uncommitted and untracked work together", async () => {
    const { repo } = await workspaceWithChanges();
    await writeFile(path.join(repo.path, "committed.txt"), "one\n", "utf8");
    await gitIn(repo.path, ["add", "-A"]);
    await gitIn(repo.path, ["commit", "--quiet", "-m", "work"]);
    await writeFile(path.join(repo.path, "README.md"), "# alpha\nedited\n", "utf8");
    await writeFile(path.join(repo.path, "scratch.txt"), "not added\n", "utf8");

    const changes = await repoChanges({ dir: "alpha", path: repo.path, baseBranch: repo.baseBranch }, 100);
    const byPath = new Map(changes.files.map((file) => [file.path, file]));
    expect(byPath.get("committed.txt")?.status).toBe("added");
    expect(byPath.get("README.md")?.status).toBe("modified");
    expect(byPath.get("scratch.txt")?.status).toBe("untracked");
    expect(changes.error).toBeNull();
  });

  it("measures against the merge base, so a moving base branch is not this thread's diff", async () => {
    const { repo, alpha } = await workspaceWithChanges();
    // Someone else lands a commit on the base branch after the thread started.
    await writeFile(path.join(alpha, "theirs.txt"), "not mine\n", "utf8");
    await gitIn(alpha, ["add", "-A"]);
    await gitIn(alpha, ["commit", "--quiet", "-m", "someone else"]);
    await gitIn(repo.path, ["fetch", "--quiet", "origin"]);

    await writeFile(path.join(repo.path, "mine.txt"), "mine\n", "utf8");
    const changes = await repoChanges({ dir: "alpha", path: repo.path, baseBranch: repo.baseBranch }, 100);
    expect(changes.files.map((file) => file.path)).toEqual(["mine.txt"]);
  });

  it("caps the file list and says it did", async () => {
    const { repo } = await workspaceWithChanges();
    for (let index = 0; index < 5; index += 1) {
      await writeFile(path.join(repo.path, `f${index}.txt`), "x\n", "utf8");
    }
    const changes = await repoChanges({ dir: "alpha", path: repo.path, baseBranch: repo.baseBranch }, 3);
    expect(changes.files).toHaveLength(3);
    expect(changes.truncated).toBe(true);
  });

  it("produces a patch for a tracked edit and for an untracked file", async () => {
    const { repo } = await workspaceWithChanges();
    await writeFile(path.join(repo.path, "README.md"), "# alpha\nchanged\n", "utf8");
    await writeFile(path.join(repo.path, "brand-new.txt"), "fresh\n", "utf8");

    const tracked = await filePatch({
      repoPath: repo.path,
      baseBranch: repo.baseBranch,
      file: "README.md",
      untracked: false,
      maxBytes: 100_000,
    });
    expect(tracked.error).toBeNull();
    expect(tracked.patch).toContain("+changed");

    // An untracked file has no HEAD side, so a plain `git diff` would not
    // mention it at all.
    const untracked = await filePatch({
      repoPath: repo.path,
      baseBranch: repo.baseBranch,
      file: "brand-new.txt",
      untracked: true,
      maxBytes: 100_000,
    });
    expect(untracked.error).toBeNull();
    expect(untracked.patch).toContain("+fresh");
  });

  it("reports live branch and working-tree state", async () => {
    const { repo } = await workspaceWithChanges();
    await writeFile(path.join(repo.path, "a.txt"), "x\n", "utf8");
    await gitIn(repo.path, ["add", "-A"]);
    await gitIn(repo.path, ["commit", "--quiet", "-m", "one"]);
    await writeFile(path.join(repo.path, "README.md"), "dirty\n", "utf8");
    await writeFile(path.join(repo.path, "untracked.txt"), "u\n", "utf8");

    const status = await repoLiveStatus({ dir: "alpha", path: repo.path, baseBranch: repo.baseBranch });
    expect(status.branch).toBe("dylan/work");
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(0);
    expect(status.dirty).toBe(1);
    expect(status.untracked).toBe(1);
    expect(status.error).toBeNull();
  });

  it("names a missing base branch instead of returning a silently empty diff", async () => {
    const { repo } = await workspaceWithChanges();
    const changes = await repoChanges({ dir: "alpha", path: repo.path, baseBranch: "no-such-branch" }, 100);
    expect(changes.files).toEqual([]);
    expect(changes.error).toContain("no-such-branch");
  });
});

describe("the per-repo failure contract", () => {
  it("lets a failed repo cross the RPC boundary, branch and base unknown", async () => {
    // Regression: `branch` and `baseBranch` were once required to be
    // non-empty, so a repo that failed before it had either would throw at
    // output validation and take the whole provisioning call with it —
    // exactly inverting the per-repo failure policy.
    const alpha = await makeRemote("alpha");
    const projectSource = path.join(scratch, "project-source");
    await mkdir(projectSource, { recursive: true });
    await bootstrapProjectSource(projectSource, EMPTY_REPOS);
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: projectSource,
      repos: [
        { dir: "alpha", url: alpha, branch: null },
        { dir: "ghost", url: path.join(scratch, "nope"), branch: null },
      ],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    for (const repo of result.repos) {
      expect(workspaceRepoSchema.safeParse(repo).success).toBe(true);
    }
  });

  it("validates a failed .bb clone, which has neither branch nor base", () => {
    const parsed = workspaceRepoSchema.safeParse({
      dir: ".bb",
      path: "/w/.bb",
      branch: "",
      baseBranch: "",
      remote: "/canonical",
      status: "failed",
      message: "clone failed",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("the cache is keyed by repo, not by project", () => {
  it("shares one bare repo between two projects on the same machine", async () => {
    // The point of the cache: adding the same repo to a second project costs
    // a delta fetch, not another full clone.
    const shared = await makeRemote("shared");
    const projectA = path.join(scratch, "project-a");
    const projectB = path.join(scratch, "project-b");
    for (const dir of [projectA, projectB]) {
      await mkdir(dir, { recursive: true });
      await bootstrapProjectSource(dir, EMPTY_REPOS);
    }

    const a = await provisionWorkspace({
      dataDir,
      pathKey: "threadA",
      projectSourcePath: projectA,
      repos: [{ dir: "shared", url: shared, branch: null }],
      branchName: "a/work",
      fetchTtlMs: 60_000,
      mirrors: [],
    });
    const b = await provisionWorkspace({
      dataDir,
      // A different project, a different thread, a different directory name.
      pathKey: "threadB",
      projectSourcePath: projectB,
      repos: [{ dir: "renamed-in-b", url: shared, branch: null }],
      branchName: "b/work",
      fetchTtlMs: 60_000,
      mirrors: [],
    });

    expect(a.repos.find((r) => r.dir === "shared")?.status).toBe("ready");
    expect(b.repos.find((r) => r.dir === "renamed-in-b")?.status).toBe("ready");

    // One cache entry, and both workspaces borrow from it.
    const cacheDir = cachePathFor(dataDir, shared).path;
    const entries = (await readdir(path.join(dataDir, "repos"))).filter((e) => e.endsWith(".git"));
    expect(entries).toEqual([path.basename(cacheDir)]);
    for (const repo of [a.repos.find((r) => r.dir === "shared")!, b.repos.find((r) => r.dir === "renamed-in-b")!]) {
      const alternates = await readFile(path.join(repo.path, ".git", "objects", "info", "alternates"), "utf8");
      expect(alternates.trim()).toBe(path.join(cacheDir, "objects"));
    }
  });

  it("does not fork the cache when two projects spell the remote differently", () => {
    // One project uses ssh, another https. Same repo, so the same entry.
    expect(cachePathFor("/data", "git@github.com:you/repo.git").key).toBe(
      cachePathFor("/data", "https://github.com/you/repo").key,
    );
  });
});

describe("standing up a brand new project", () => {
  it("bootstraps a project source whose directory does not exist yet", async () => {
    // The panel's Commit and `bb repos add --project` both land here on a new
    // project: a fresh machine's workspace directory is empty, so the repo
    // set has to be able to create the repo that holds it.
    const dir = path.join(scratch, "never-created", "acme");
    expect(await exists(dir)).toBe(false);

    const result = await bootstrapProjectSource(dir, EMPTY_REPOS);
    expect(result.bootstrapped).toBe(true);
    expect(await exists(path.join(dir, ".git"))).toBe(true);

    // And the repo set commits straight afterwards, which is the sequence
    // saveRepoSet performs.
    const written = await writeReposJson(
      dir,
      `{"version":1,"repos":[{"dir":"a","url":"https://example.com/a"}]}\n`,
      "Update the repo set",
    );
    expect(written.committed).toBe(true);
    expect(parseReposFile((await readReposJson(dir))!).ok).toBe(true);
  });

  it("writing a repo set without bootstrapping first refuses rather than half-succeeding", async () => {
    // The old behavior, kept honest: a directory that is not a repo gets a
    // named failure, not a silent uncommitted write.
    const dir = path.join(scratch, "plain-directory");
    await mkdir(dir, { recursive: true });
    const written = await writeReposJson(dir, `{"version":1,"repos":[]}\n`, "Update the repo set");
    expect(written.committed).toBe(false);
    expect(written.message).not.toBeNull();
  });
});

describe("creating a project source", () => {
  it("seeds a fresh .bb with the repos it was given, and leaves an existing one alone", async () => {
    const dir = path.join(scratch, "fresh");
    const seeded = await bootstrapProjectSource(dir, {
      version: 1,
      repos: [{ dir: "alpha", url: "https://example.com/alpha", inferredDir: true }],
    });
    expect(seeded.bootstrapped).toBe(true);
    const text = await readReposJson(dir);
    expect(text).not.toBeNull();
    const parsed = parseReposFile(text ?? "");
    expect(parsed.ok && parsed.value.repos.map((repo) => repo.dir)).toEqual(["alpha"]);
    // The inferred dir is written as the absence it was.
    expect(JSON.parse(text ?? "")).toEqual({ version: 1, repos: [{ url: "https://example.com/alpha" }] });
    // Committed, so the project can be cloned from here on.
    expect(await gitLine(dir, ["rev-parse", "HEAD"])).not.toBeNull();

    const again = await bootstrapProjectSource(dir, {
      version: 1,
      repos: [{ dir: "beta", url: "https://example.com/beta" }],
    });
    expect(again.bootstrapped).toBe(false);
    expect(await readReposJson(dir)).toBe(text);
  });

  it("clones an existing .bb repo into an empty or absent directory", async () => {
    const remote = await makeRemote("shared-bb");
    await writeFile(path.join(remote, "repos.json"), '{"version":1,"repos":[]}\n', "utf8");
    await gitIn(remote, ["add", "-A"]);
    await gitIn(remote, ["commit", "--quiet", "-m", "repo set"]);

    const absent = path.join(scratch, "projects", "absent");
    expect(await cloneProjectSource(remote, absent)).toEqual({ ok: true, message: null });
    expect(await readReposJson(absent)).toBe('{"version":1,"repos":[]}\n');
    expect(await gitLine(absent, ["config", "--get", "remote.origin.url"])).toBe(remote);

    const empty = path.join(scratch, "projects", "empty");
    await mkdir(empty, { recursive: true });
    expect((await cloneProjectSource(remote, empty)).ok).toBe(true);
  });

  it("refuses to clone over a directory with contents, and a URL that reads as an option", async () => {
    const remote = await makeRemote("shared-bb");
    const occupied = path.join(scratch, "projects", "occupied");
    await mkdir(occupied, { recursive: true });
    await writeFile(path.join(occupied, "note.txt"), "x", "utf8");
    const result = await cloneProjectSource(remote, occupied);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not empty");
    expect((await cloneProjectSource("--upload-pack=x", path.join(scratch, "projects", "opt"))).ok).toBe(false);
  });

  it("suggests a location under the home directory, named after the project", async () => {
    const suggestion = await defaultProjectSourcePath("My Project");
    expect(suggestion.path).toBe(path.join(homedir(), "bb", "my-project"));
    expect(typeof suggestion.exists).toBe("boolean");
  });
});
