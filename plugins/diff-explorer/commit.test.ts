import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { reviewCommit, finishCommit } from "./commit";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./host";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const run = promisify(execFile);
const MESSAGE = "Make the selected behavior clearer.\n\n- Explain the reason for the selected changes.\n- Keep unrelated work available for a separate commit.\n";

async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "bb-commit-test-"));
  const git = async (...args: string[]) => (await run("git", ["-C", root, ...args])).stdout;
  await git("init", "-b", "feature");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "commit.gpgsign", "false");
  for (const name of ["a.txt", "b.txt", "deleted.txt"]) await writeFile(path.join(root, name), "base\n");
  await git("add", "--", "a.txt", "b.txt", "deleted.txt");
  await git("commit", "-m", "Initial fixture");
  const message = path.join(root, "message.txt");
  await writeFile(message, MESSAGE);
  return { root, git, message, close: () => rm(root, { recursive: true, force: true }) };
}

test("review leaves staging untouched; finish commits literal paths, renames, deletions and untracked files while preserving unrelated staging", async () => {
  const r = await repo();
  try {
    await writeFile(path.join(r.root, "a.txt"), "reviewed\n");
    await writeFile(path.join(r.root, "b.txt"), "staged unrelated\n");
    await r.git("add", "--", "b.txt");
    await writeFile(path.join(r.root, "b.txt"), "unstaged unrelated\n");
    await r.git("mv", "deleted.txt", "renamed.txt");
    await writeFile(path.join(r.root, "literal[1].txt"), "new\n");
    const paths = ["a.txt", "deleted.txt", "renamed.txt", "literal[1].txt"];
    const staged = await r.git("diff", "--cached", "--binary");
    const beforeHead = await r.git("rev-parse", "HEAD");
    const reviewed = await reviewCommit(r.root, paths);
    assert.match(reviewed.diff, /reviewed/);
    assert.match(reviewed.diff, /literal\[1\]/);
    assert.equal(await r.git("diff", "--cached", "--binary"), staged);
    const result = await finishCommit(r.root, paths, reviewed.snapshot, r.message, false);
    assert.equal(result.error, null, result.error ?? undefined);
    assert.equal(result.pushed, false);
    assert.notEqual(result.commit + "\n", beforeHead);
    assert.equal(await r.git("show", "HEAD:a.txt"), "reviewed\n");
    assert.equal(await r.git("show", "HEAD:b.txt"), "base\n");
    assert.equal(await r.git("show", ":b.txt"), "staged unrelated\n");
    assert.equal(await readFile(path.join(r.root, "b.txt"), "utf8"), "unstaged unrelated\n");
    assert.equal(await r.git("diff", "--cached", "--name-only"), "b.txt\n");
    assert.equal(await r.git("show", "--format=%B", "--no-patch", "HEAD"), MESSAGE + "\n");
    assert.equal(await r.git("diff", "HEAD", "--", ...paths), "");
  } finally { await r.close(); }
});

test("finish refuses changed working files, staging, HEAD and branches without mutating the real index", async () => {
  for (const changed of ["files", "staging", "head", "branch"]) {
    const r = await repo();
    try {
      await writeFile(path.join(r.root, "a.txt"), "reviewed\n");
      const { snapshot } = await reviewCommit(r.root, ["a.txt"]);
      if (changed === "files") await writeFile(path.join(r.root, "a.txt"), "new edit\n");
      if (changed === "staging") { await writeFile(path.join(r.root, "b.txt"), "new staged\n"); await r.git("add", "--", "b.txt"); }
      if (changed === "head") await r.git("commit", "--allow-empty", "-m", "Concurrent commit");
      if (changed === "branch") await r.git("switch", "-c", "other");
      const head = await r.git("rev-parse", "HEAD");
      const index = await r.git("ls-files", "--stage", "-z");
      const result = await finishCommit(r.root, ["a.txt"], snapshot, r.message, false);
      assert.match(result.error!, /changed since review/, changed);
      assert.equal(result.commit, null);
      assert.equal(await r.git("rev-parse", "HEAD"), head);
      assert.equal(await r.git("ls-files", "--stage", "-z"), index);
    } finally { await r.close(); }
  }
});

test("repository hooks run, and failed hooks or hook edits stop before committing with the original staging preserved", async () => {
  for (const hook of ["reject", "edit", "stage", "message"]) {
    const r = await repo();
    try {
      await writeFile(path.join(r.root, "a.txt"), "reviewed\n");
      await writeFile(path.join(r.root, "b.txt"), "unrelated staged\n");
      await r.git("add", "--", "b.txt");
      const dir = path.join(r.root, "custom-hooks");
      await mkdir(dir);
      await r.git("config", "core.hooksPath", hook === "stage" ? "custom-hooks" : dir);
      const script = {
        reject: "echo hook-ran > hook-marker\nexit 1\n",
        edit: "echo hook-ran > hook-marker\necho hook-edit > a.txt\n",
        stage: "echo hook-ran > hook-marker\ngit add -- b.txt\n",
        message: 'echo hook-ran > hook-marker\necho changed-message > "$1"\n',
      }[hook]!;
      await writeFile(path.join(dir, hook === "message" ? "commit-msg" : "pre-commit"), "#!/bin/sh\n" + script, { mode: 0o700 });
      const { snapshot } = await reviewCommit(r.root, ["a.txt"]);
      const head = await r.git("rev-parse", "HEAD");
      const staged = await r.git("diff", "--cached", "--binary");
      const result = await finishCommit(r.root, ["a.txt"], snapshot, r.message, false);
      assert.ok(result.error, hook);
      assert.equal(result.commit, null);
      assert.equal(await readFile(path.join(r.root, "hook-marker"), "utf8"), "hook-ran\n");
      assert.equal(await r.git("rev-parse", "HEAD"), head);
      assert.equal(await r.git("diff", "--cached", "--binary"), staged);
    } finally { await r.close(); }
  }
});

test("push targets the current branch even with a differently named upstream; rejected pushes keep the local commit", async () => {
  const remote = await mkdtemp(path.join(os.tmpdir(), "bb-commit-remote-"));
  const r = await repo();
  try {
    await run("git", ["init", "--bare", remote]);
    await r.git("remote", "add", "origin", remote);
    await r.git("push", "origin", "HEAD:refs/heads/main");
    await r.git("config", "branch.feature.remote", "origin");
    await r.git("config", "branch.feature.merge", "refs/heads/main");
    const main = (await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout;
    await writeFile(path.join(r.root, "a.txt"), "reviewed\n");
    const { snapshot } = await reviewCommit(r.root, ["a.txt"]);
    const result = await finishCommit(r.root, ["a.txt"], snapshot, r.message, true);
    assert.equal(result.error, null, result.error ?? undefined);
    assert.equal(result.pushed, true);
    assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout, main);
    assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/feature"])).stdout.trim(), result.commit);
    await writeFile(path.join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await writeFile(path.join(r.root, "a.txt"), "second review\n");
    const next = await reviewCommit(r.root, ["a.txt"]);
    const rejected = await finishCommit(r.root, ["a.txt"], next.snapshot, r.message, true);
    assert.match(rejected.error!, /git push failed/);
    assert.ok(rejected.commit);
    assert.equal(rejected.pushed, false);
    assert.equal((await r.git("rev-parse", "HEAD")).trim(), rejected.commit);
    assert.equal(await r.git("diff", "--cached"), "");
  } finally { await r.close(); await rm(remote, { recursive: true, force: true }); }
});

test("unborn repositories work; unsafe selections and message attribution are rejected", async () => {
  const r = await repo();
  try {
    await r.git("checkout", "--orphan", "fresh");
    await writeFile(path.join(r.root, "a.txt"), "initial reviewed\n");
    const reviewed = await reviewCommit(r.root, ["a.txt"]);
    assert.equal(reviewed.snapshot.head, null);
    const result = await finishCommit(r.root, ["a.txt"], reviewed.snapshot, r.message, false);
    assert.equal(result.error, null, result.error ?? undefined);
    await assert.rejects(reviewCommit(r.root, ["../outside"]), /inside the repository/);
    await mkdir(path.join(r.root, "directory"));
    await assert.rejects(reviewCommit(r.root, ["directory"]), /individual files/);
    await symlink(os.tmpdir(), path.join(r.root, "outside"));
    await assert.rejects(reviewCommit(r.root, ["outside/file"]), /escapes the workspace/);
    await writeFile(r.message, MESSAGE + "Co-Authored-By: Bot\n");
    await assert.rejects(finishCommit(r.root, ["a.txt"], reviewed.snapshot, r.message, false), /no Co-Authored-By/);
  } finally { await r.close(); }
});

test("host RPC works in a linked worktree and refuses an existing index lock without removing it", async () => {
  const r = await repo();
  const directory = await mkdtemp(path.join(os.tmpdir(), "bb-commit-worktree-"));
  const root = path.join(directory, "checkout");
  const host = experimental_createHostEntryHarness(hostEntry);
  try {
    await r.git("worktree", "add", "-b", "linked", root);
    await writeFile(path.join(root, "a.txt"), "linked reviewed\n");
    const messageFile = path.join(root, "message.txt");
    await writeFile(messageFile, MESSAGE);
    const review = await host.experimental_call("reviewCommit", { root, paths: ["a.txt"] });
    const index = (await run("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
    await writeFile(`${index}.lock`, "another operation");
    const blocked = await host.experimental_call("finishCommit", { root, paths: ["a.txt"], snapshot: review.snapshot, messageFile, push: false });
    assert.equal(blocked.commit, null);
    assert.match(blocked.error!, /EEXIST/);
    assert.equal(await readFile(`${index}.lock`, "utf8"), "another operation");
    await rm(`${index}.lock`);
    const result = await host.experimental_call("finishCommit", { root, paths: ["a.txt"], snapshot: review.snapshot, messageFile, push: false });
    assert.equal(result.error, null, result.error ?? undefined);
    assert.equal(await r.git("show", "HEAD:a.txt"), "base\n");
    assert.equal((await run("git", ["-C", root, "show", "HEAD:a.txt"])).stdout, "linked reviewed\n");
  } finally {
    await host.experimental_dispose();
    await rm(directory, { recursive: true, force: true });
    await r.close();
  }
});

test("finish accepts Claude's shared /tmp message directory as well as the host's per-user TMPDIR", async () => {
  const r = await repo();
  const directory = await mkdtemp("/tmp/bb-commit-message-");
  try {
    const message = path.join(directory, "message.txt");
    await writeFile(message, MESSAGE);
    await writeFile(path.join(r.root, "a.txt"), "reviewed\n");
    const { snapshot } = await reviewCommit(r.root, ["a.txt"]);
    const result = await finishCommit(r.root, ["a.txt"], snapshot, message, false);
    assert.equal(result.error, null, result.error ?? undefined);
    assert.ok(result.commit);
  } finally { await r.close(); await rm(directory, { recursive: true, force: true }); }
});
