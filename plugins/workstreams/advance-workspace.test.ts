import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAdvanceWorkspace, type AdvanceGitRunner } from "./advance-workspace.js";
import type { GhRunner } from "./ghactions.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "workstreams-advance-"));
  directories.push(directory);
  const sourcePath = join(directory, "source");
  const git = async (...args: string[]) => (await exec("git", args, { cwd: sourcePath })).stdout.trim();
  await exec("git", ["init", "-b", "main", sourcePath]);
  await git("config", "user.name", "Test User");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(join(sourcePath, "file.txt"), "base\n");
  await git("add", "."); await git("commit", "-m", "Base fixture");
  const base = await git("rev-parse", "HEAD");
  await git("checkout", "-b", "feature");
  await writeFile(join(sourcePath, "file.txt"), "feature\n");
  await git("commit", "-am", "Feature fixture");
  const head = await git("rev-parse", "HEAD");
  await git("update-ref", "refs/pull/42/head", head);
  const remotePath = join(directory, "remote.git");
  await exec("git", ["clone", "--bare", sourcePath, remotePath]);
  await exec("git", ["--git-dir", remotePath, "update-ref", "refs/pull/42/head", head]);
  await git("remote", "add", "origin", "https://github.com/example/widget.git");
  // Keep dirty author work in place; provisioning must never inspect/reset it.
  await writeFile(join(sourcePath, "file.txt"), "uncommitted author work\n");
  const run: AdvanceGitRunner = async (args, cwd) => {
    const actual = [...args];
    if (actual[0] === "fetch") actual[actual.indexOf("origin")] = remotePath;
    try { return { ok: true, stdout: (await exec("git", actual, { cwd })).stdout }; }
    catch (error) { return { ok: false, error: String(error) }; }
  };
  const input = { sourcePath, prUrl: "https://github.com/example/widget/pull/42", expectedHeadOid: head, expectedBaseOid: base, batchId: "batch-1", jobId: "job-42" };
  const gh: GhRunner = async (args) => {
    const value = args[0] === "api" ? { data: { repository: { pullRequest: {
      headRefOid: head, baseRefOid: "c".repeat(40), baseRefName: "main", baseRef: { name: "main", target: { oid: base } }, reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    } } } } : args[1] === "list" ? [] : {
      url: input.prUrl, number: 42, title: "Fix account lookup", state: "OPEN", isDraft: false, isCrossRepository: false,
      headRefName: "feature", baseRefName: "main", headRefOid: head, baseRefOid: "c".repeat(40),
      reviewDecision: "APPROVED", mergeStateStatus: "BEHIND", mergeable: "MERGEABLE", latestReviews: [], statusCheckRollup: [],
    };
    return { ok: true, stdout: JSON.stringify(value) };
  };
  return { directory, sourcePath, git, head, base, run, gh, input, root: join(directory, "workspaces") };
}

describe("isolated advance workspaces", () => {
  it("creates the exact PR checkout using the live base tip despite a stale PR base snapshot, then reuses it", async () => {
    const f = await fixture();
    const first = await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root);
    expect(first).toMatchObject({ ok: true, created: true });
    if (!first.ok) throw new Error(first.error);
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: first.path })).stdout.trim()).toBe(f.head);
    expect((await exec("git", ["branch", "--show-current"], { cwd: first.path })).stdout.trim()).toBe("");
    expect(first.workerPath).toBe(join(f.root, "batch-1", "example--widget"));
    expect(await readFile(join(f.sourcePath, "file.txt"), "utf8")).toBe("uncommitted author work\n");
    expect(await f.git("branch", "--show-current")).toBe("feature");
    expect(await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root)).toMatchObject({ ok: true, path: first.path, created: false });
  });

  it("preserves a changed batch checkout instead of silently resetting an interrupted job", async () => {
    const f = await fixture();
    const first = await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root);
    if (!first.ok) throw new Error(first.error);
    await writeFile(join(first.path, "file.txt"), "unfinished conflict resolution\n");
    expect(await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root)).toMatchObject({ ok: false, error: expect.stringContaining("preserved") });
    expect(await readFile(join(first.path, "file.txt"), "utf8")).toBe("unfinished conflict resolution\n");
  });

  it("refuses a changed expected commit before creating a worktree", async () => {
    const f = await fixture();
    expect(await prepareAdvanceWorkspace(f.run, f.gh, { ...f.input, expectedHeadOid: "c".repeat(40) }, f.root))
      .toMatchObject({ ok: false, error: expect.stringContaining("changed") });
    expect((await f.git("worktree", "list", "--porcelain")).match(/^worktree /gmu)).toHaveLength(1);
  });

  it("refuses another repository's source or push destination", async () => {
    const f = await fixture();
    await f.git("remote", "set-url", "--push", "origin", "https://github.com/other/widget.git");
    expect(await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root)).toMatchObject({ ok: false, error: expect.stringContaining("push origin") });
    await f.git("remote", "set-url", "origin", "https://github.com/other/widget.git");
    expect(await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root)).toMatchObject({ ok: false, error: expect.stringContaining("source origin") });
  });

  it("rejects traversal in batch identifiers before any git command", async () => {
    let called = false;
    const run: AdvanceGitRunner = async () => { called = true; return { ok: false, error: "unexpected" }; };
    expect(await prepareAdvanceWorkspace(run, async () => ({ ok: false, error: "unexpected" }), {
      sourcePath: "/synthetic", prUrl: "https://github.com/example/widget/pull/42", expectedHeadOid: "a".repeat(40), expectedBaseOid: "b".repeat(40), batchId: "../escape", jobId: "job",
    })).toMatchObject({ ok: false });
    expect(called).toBe(false);
  });
});
