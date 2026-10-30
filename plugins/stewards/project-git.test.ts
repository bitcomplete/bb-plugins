// The native project source's git handler (project-git.ts): it must read the
// committed `origin/<default>`, never the working tree or a local branch, and
// must not touch the working tree while doing so.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectGit } from "./project-git.js";

const roots: string[] = [];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    // A CI runner has no global git identity; every commit in these tests gets one.
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
  });

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bb-stewards-git-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A bare origin and a clone of it, both under a fresh temp root. */
async function world(): Promise<{ origin: string; checkout: string }> {
  const root = await tempRoot();
  const origin = path.join(root, "origin.git");
  const checkout = path.join(root, "checkout");
  git(root, "init", "--bare", "--quiet", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, checkout);
  git(checkout, "config", "user.email", "test@example.com");
  git(checkout, "config", "user.name", "Test");
  await mkdir(path.join(checkout, ".bb", "stewards"), { recursive: true });
  await writeFile(path.join(checkout, ".bb", "stewards", "project.json"), '{"version":1,"marker":"committed"}\n', "utf8");
  await writeFile(path.join(checkout, ".bb", "AGENTS.md"), "committed guidance\n", "utf8");
  git(checkout, "add", "-A");
  git(checkout, "commit", "--quiet", "-m", "add .bb");
  git(checkout, "push", "--quiet", "-u", "origin", "main");
  return { origin, checkout };
}

describe("the native git project source", () => {
  it("reads .bb from origin/main, never the working tree or a local commit", async () => {
    const { checkout } = await world();
    // A dirty edit the developer is halfway through, and a local commit not
    // pushed: neither is the project's.
    await writeFile(path.join(checkout, ".bb", "stewards", "project.json"), '{"version":1,"marker":"dirty"}\n', "utf8");
    await writeFile(path.join(checkout, ".bb", "AGENTS.md"), "dirty guidance\n", "utf8");
    await writeFile(path.join(checkout, ".bb", "stewards", "other.json"), "{}\n", "utf8");
    git(checkout, "add", ".bb/stewards/other.json");
    git(checkout, "commit", "--quiet", "-m", "local only");

    const read = await readProjectGit({ path: checkout, files: ["stewards/project.json", "AGENTS.md", "stewards/roles.json"] });
    expect(read.error).toBeNull();
    expect(read.defaultBranch).toBe("main");
    expect(read.layout).toBe("primary");
    const byPath = new Map(read.files.map((f) => [f.path, f.content]));
    expect(byPath.get("stewards/project.json")).toContain('"marker":"committed"');
    expect(byPath.get("stewards/project.json")).not.toContain("dirty");
    expect(byPath.get("AGENTS.md")).toBe("committed guidance\n");
    expect(byPath.get("stewards/roles.json")).toBeNull();
  });

  it("leaves the working tree, HEAD and branch exactly as they were", async () => {
    const { checkout } = await world();
    await writeFile(path.join(checkout, ".bb", "stewards", "project.json"), '{"version":1,"marker":"dirty"}\n', "utf8");
    const headBefore = git(checkout, "rev-parse", "HEAD").trim();
    const branchBefore = git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim();
    const statusBefore = git(checkout, "status", "--porcelain");

    await readProjectGit({ path: checkout, files: ["stewards/project.json"] });

    expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(branchBefore);
    expect(git(checkout, "status", "--porcelain")).toBe(statusBefore);
    expect(await readFile(path.join(checkout, ".bb", "stewards", "project.json"), "utf8")).toContain("dirty");
  });

  it("adds nothing at all to the checkout when it does not fetch", async () => {
    const { checkout } = await world();
    const listing = () => execFileSync("find", [checkout, "-type", "f"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
    const before = listing();
    const read = await readProjectGit({ path: checkout, files: ["stewards/project.json"], fetch: false });
    expect(read.error).toBeNull();
    expect(listing()).toEqual(before);
  });

  it("reads a standalone .bb checkout at its root, and reports its origin", async () => {
    const { origin, checkout } = await world();
    const standalone = path.join(path.dirname(checkout), "standalone");
    git(path.dirname(checkout), "clone", "--quiet", origin, standalone);
    git(standalone, "config", "user.email", "test@example.com");
    git(standalone, "config", "user.name", "Test");
    // A standalone checkout keeps the definition at the root instead of `.bb/`.
    await rm(path.join(standalone, ".bb"), { recursive: true, force: true });
    await mkdir(path.join(standalone, "stewards"), { recursive: true });
    await writeFile(path.join(standalone, "stewards", "project.json"), '{"version":1,"marker":"standalone"}\n', "utf8");
    git(standalone, "add", "-A");
    git(standalone, "commit", "--quiet", "-m", "standalone layout");
    git(standalone, "push", "--quiet", "origin", "main");

    const read = await readProjectGit({ path: standalone, files: ["stewards/project.json"] });
    expect(read.error).toBeNull();
    expect(read.layout).toBe("standalone");
    expect(read.files[0]?.content).toContain("standalone");
    expect(read.remote).toBe(origin);
  });

  it("refuses a traversal path rather than running git with it", async () => {
    const { checkout } = await world();
    const read = await readProjectGit({ path: checkout, files: ["../secret"] });
    expect(read.error).toMatch(/not a project file path/u);
    expect(read.files).toEqual([]);
  });

  it("names an oversized file instead of returning a bare git error", async () => {
    const { checkout } = await world();
    await writeFile(path.join(checkout, ".bb", "stewards", "big.json"), "x".repeat(700_000), "utf8");
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "big");
    git(checkout, "push", "--quiet", "origin", "main");
    const read = await readProjectGit({ path: checkout, files: ["stewards/project.json", "stewards/big.json"] });
    expect(read.error).toMatch(/Larger than 200000 characters, so not read: stewards\/big\.json/u);
    const byPath = new Map(read.files.map((f) => [f.path, f.content]));
    expect(byPath.get("stewards/big.json")).toBeNull();
    expect(byPath.get("stewards/project.json")).not.toBeNull();
  });
});
