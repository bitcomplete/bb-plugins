/**
 * The primary-repo layout (BB-106): `.bb/` is a directory on the primary
 * repo's default branch, the project source is a clone of that repo, and
 * `repos.json` lists only the other repos.
 *
 * Built against real git repositories because the properties that matter —
 * reads from the default branch rather than the working tree, `.bb/` landing
 * at the workspace root, guidance publishing to a branch and not the default —
 * are git facts, not string shapes.
 */
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PluginEnvironmentProviderCreateContext,
  PluginEnvironmentProviderProgress,
} from "@get-bb/plugin-sdk/environment-provider";
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { git, gitIn, gitLine } from "./git.js";
import { EMPTY_REPOS, dirFromUrl } from "./repos.js";
import { repoSetViewSchema } from "./contract.js";
import plugin from "./server.js";
import { ENVIRONMENT_PROVIDER_ID } from "./shared.js";
import {
  adoptProjectSource,
  bootstrapProjectSource,
  detectProjectLayout,
  mergeGuidance,
  preparePrimaryProjectSource,
  pushGuidance,
  readCommittedFiles,
  readReposJson,
  resolveDefaultBranchRef,
} from "./source.js";
import { repoLiveStatus } from "./diff.js";
import { provisionWorkspace } from "./workspace.js";

let scratch: string;
let dataDir: string;

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function makeRepo(name: string, branch = "main"): Promise<string> {
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

/** Add `.bb/` to a repo on its current branch and commit it. */
async function commitDefinition(dir: string, agents = "primary guidance\n"): Promise<void> {
  await mkdir(path.join(dir, ".bb", "skills"), { recursive: true });
  await writeFile(path.join(dir, ".bb", "repos.json"), '{"version":1,"repos":[]}\n', "utf8");
  await writeFile(path.join(dir, ".bb", "AGENTS.md"), agents, "utf8");
  await writeFile(path.join(dir, ".bb", "skills", ".gitkeep"), "", "utf8");
  await gitIn(dir, ["add", "-A"]);
  await gitIn(dir, ["commit", "--quiet", "-m", "add .bb"]);
}

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "multi-repo-primary-"));
  dataDir = path.join(scratch, "host-data");
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("the panel's repo-set view", () => {
  it("carries the layout and the primary without a branch field", () => {
    const parsed = repoSetViewSchema.safeParse({
      projectSourcePath: "/home/me/primary",
      hostId: "host-a",
      layout: "primary",
      primary: { dir: "primary", url: "git@github.com:you/primary.git" },
      reposJson: null,
      repos: [],
      error: null,
      cache: [],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("layout detection", () => {
  it("calls a root-level definition standalone and a .bb/ one primary", async () => {
    const standalone = path.join(scratch, "standalone");
    await mkdir(standalone, { recursive: true });
    await bootstrapProjectSource(standalone, EMPTY_REPOS);
    expect(await detectProjectLayout(standalone)).toBe("standalone");

    const primary = await makeRepo("primary");
    await commitDefinition(primary);
    expect(await detectProjectLayout(primary)).toBe("primary");
  });

  it("does not flip layout on an uncommitted .bb/ in the working tree", async () => {
    const standalone = path.join(scratch, "standalone");
    await mkdir(standalone, { recursive: true });
    await bootstrapProjectSource(standalone, EMPTY_REPOS);
    // A person halfway through creating `.bb/`: not committed, so not the layout.
    await mkdir(path.join(standalone, ".bb"), { recursive: true });
    await writeFile(path.join(standalone, ".bb", "repos.json"), "{}\n", "utf8");
    expect(await detectProjectLayout(standalone)).toBe("standalone");
  });
});

describe("default-branch reads", () => {
  it("reads repos.json from the default branch, not the checked-out feature branch", async () => {
    const remote = await makeRepo("primary");
    await commitDefinition(remote);
    const clone = path.join(scratch, "primary-clone");
    await git(["clone", "--quiet", remote, clone]);
    await gitIn(clone, ["config", "user.email", "test@example.invalid"]);
    await gitIn(clone, ["config", "user.name", "Test"]);

    await gitIn(clone, ["checkout", "--quiet", "-b", "feature"]);
    await writeFile(path.join(clone, ".bb", "repos.json"), '{"version":1,"repos":[{"dir":"x","url":"u"}]}\n', "utf8");
    await gitIn(clone, ["add", "-A"]);
    await gitIn(clone, ["commit", "--quiet", "-m", "feature edit"]);

    expect(await resolveDefaultBranchRef(clone)).toBe("refs/heads/main");
    // The feature branch's edit is not the project's committed default truth.
    expect(await readReposJson(clone, "primary")).toBe('{"version":1,"repos":[]}\n');
  });

  it("reads project files from .bb/ at the default branch for another plugin", async () => {
    const primary = await makeRepo("primary");
    await mkdir(path.join(primary, ".bb", "stewards"), { recursive: true });
    await writeFile(path.join(primary, ".bb", "stewards", "project.json"), '{"version":1}\n', "utf8");
    await gitIn(primary, ["add", "-A"]);
    await gitIn(primary, ["commit", "--quiet", "-m", "add stewards config"]);

    const read = await readCommittedFiles(primary, ["stewards/project.json"], 200_000, undefined, { prefix: ".bb/" });
    expect(read.error).toBeNull();
    expect(read.files[0]).toEqual({ path: "stewards/project.json", content: '{"version":1}\n' });
  });

  it("prefers the local default branch when the plugin's own commit is ahead of origin", async () => {
    const remote = await makeRepo("primary");
    await commitDefinition(remote);
    const clone = path.join(scratch, "primary-clone");
    await git(["clone", "--quiet", remote, clone]);
    await gitIn(clone, ["config", "user.email", "test@example.invalid"]);
    await gitIn(clone, ["config", "user.name", "Test"]);
    // The plugin's own `.bb` edit, committed locally and not pushed.
    await writeFile(path.join(clone, ".bb", "repos.json"), '{"version":1,"repos":[{"dir":"mine","url":"u"}]}\n', "utf8");
    await gitIn(clone, ["add", "-A"]);
    await gitIn(clone, ["commit", "--quiet", "-m", "local edit"]);

    expect(await resolveDefaultBranchRef(clone)).toBe("refs/heads/main");
    expect(await readReposJson(clone, "primary")).toContain('"mine"');
  });
});

describe("provisioning from a primary repo", () => {
  async function provisionPrimary(primaryDir = "primary"): Promise<{
    primary: string;
    canonical: string;
    result: Awaited<ReturnType<typeof provisionWorkspace>>;
  }> {
    const primary = await makeRepo("primary");
    await commitDefinition(primary, "cross-repo guidance\n");
    const canonical = path.join(scratch, "canonical");
    await git(["clone", "--quiet", primary, canonical]);
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: canonical,
      layout: "primary",
      primaryDir,
      repos: [{ dir: "primary", url: primary, branch: null }],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    return { primary, canonical, result };
  }

  it("clones the primary, links .bb to the primary clone's .bb/, and leaves the root non-git", async () => {
    const { result } = await provisionPrimary();

    expect(await exists(path.join(result.root, ".git"))).toBe(false);
    expect(await exists(path.join(result.root, "primary", ".git"))).toBe(true);
    // Core reads `.bb/AGENTS.md` and `.bb/skills` from the workspace root, so
    // the definition is reachable there — as a link into the primary clone,
    // relative so the workspace resolves wherever it is mounted.
    expect((await lstat(path.join(result.root, ".bb"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(result.root, ".bb"))).toBe(path.join("primary", ".bb"));
    expect(await readFile(path.join(result.root, ".bb", "AGENTS.md"), "utf8")).toBe("cross-repo guidance\n");
    expect(await exists(path.join(result.root, ".bb", "repos.json"))).toBe(true);
    expect(await exists(path.join(result.root, ".bb", ".git"))).toBe(false);
    expect(result.definitionLinked).toBe(true);
    const source = result.repos.find((repo) => repo.dir === ".bb");
    expect(source?.status).toBe("ready");
  });

  it("shows the thread's own checkout: an edit under .bb/ is a change in the primary clone", async () => {
    const { result } = await provisionPrimary();
    await writeFile(path.join(result.root, ".bb", "AGENTS.md"), "edited in the thread\n", "utf8");
    expect(await readFile(path.join(result.root, "primary", ".bb", "AGENTS.md"), "utf8")).toBe("edited in the thread\n");
    const status = await gitIn(path.join(result.root, "primary"), ["status", "--porcelain"]);
    expect(status.stdout.trimEnd()).toBe(" M .bb/AGENTS.md");
  });

  it("publishes the edits behind the link as guidance-<thread>, leaving the thread branch alone", async () => {
    const { canonical, result } = await provisionPrimary();
    await writeFile(path.join(result.root, ".bb", "AGENTS.md"), "learned through the link\n", "utf8");
    const published = await pushGuidance(canonical, path.join(result.root, ".bb"), "thr_linked", undefined, result.definitionBase);
    expect(published.ok).toBe(true);
    expect(await gitLine(canonical, ["show", "guidance-thr_linked:.bb/AGENTS.md"])).toBe("learned through the link");
    expect(await gitLine(canonical, ["show", "HEAD:.bb/AGENTS.md"])).toBe("cross-repo guidance");
    // The guidance branch carries .bb/ only; the primary clone's branch has no new commit.
    const clone = path.join(result.root, "primary");
    expect(await gitLine(clone, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("dylan/work");
    expect((await gitIn(clone, ["log", "--oneline", "main..HEAD"])).stdout.trim()).toBe("");
  });

  it("reports the linked .bb row by its target rather than the primary's status again", async () => {
    const { result } = await provisionPrimary();
    await writeFile(path.join(result.root, "primary", "README.md"), "changed\n", "utf8");
    const status = await repoLiveStatus({ dir: ".bb", path: path.join(result.root, ".bb"), baseBranch: "default" });
    expect(status.branch).toBeNull();
    expect(status.dirty).toBe(0);
    expect(status.error).toBe(`Linked to ${path.join("primary", ".bb")}.`);
  });

  it("leaves a link that still resolves alone when create() is re-entered", async () => {
    const { primary, canonical } = await provisionPrimary();
    const again = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: canonical,
      layout: "primary",
      primaryDir: "primary",
      repos: [{ dir: "primary", url: primary, branch: null }],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    expect(again.definitionLinked).toBe(true);
    expect((await lstat(path.join(again.root, ".bb"))).isSymbolicLink()).toBe(true);
  });

  it("falls back to a copy of the default branch's .bb/ when the primary clone has none to link", async () => {
    // `primaryDir` names a directory that is not in the workspace: the primary
    // failed to clone, or the thread branch predates `.bb/`.
    const { result } = await provisionPrimary("elsewhere");
    expect(result.definitionLinked).toBe(false);
    expect((await lstat(path.join(result.root, ".bb"))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(result.root, ".bb", "AGENTS.md"), "utf8")).toBe("cross-repo guidance\n");
    expect(await exists(path.join(result.root, ".bb", ".git"))).toBe(false);
    expect(result.repos.find((repo) => repo.dir === ".bb")?.status).toBe("ready");
  });

  it("fails the .bb row by name when the primary does not carry .bb/ on the branch", async () => {
    const primary = await makeRepo("primary");
    const canonical = path.join(scratch, "canonical");
    await git(["clone", "--quiet", primary, canonical]);
    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: canonical,
      layout: "primary",
      primaryDir: "primary",
      repos: [{ dir: "primary", url: primary, branch: null }],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    const source = result.repos.find((repo) => repo.dir === ".bb");
    expect(source?.status).toBe("failed");
    expect(source?.message).toContain(".bb/");
  });
});

describe("guidance on a primary repo", () => {
  async function pair(): Promise<{ canonical: string; workspaceBb: string }> {
    const primary = await makeRepo("primary");
    await commitDefinition(primary, "before\n");
    const canonical = path.join(scratch, "canonical");
    await git(["clone", "--quiet", primary, canonical]);
    // The workspace's copy of `.bb`, edited by the agent.
    const workspaceBb = path.join(scratch, "workspace-bb");
    await mkdir(workspaceBb, { recursive: true });
    await writeFile(path.join(workspaceBb, "AGENTS.md"), "learned something\n", "utf8");
    await writeFile(path.join(workspaceBb, "repos.json"), '{"version":1,"repos":[]}\n', "utf8");
    return { canonical, workspaceBb };
  }

  it("publishes guidance-<thread> without moving the default branch", async () => {
    const { canonical, workspaceBb } = await pair();
    const before = await gitLine(canonical, ["rev-parse", "HEAD"]);
    const result = await pushGuidance(canonical, workspaceBb, "thr_abc123");
    expect(result.ok).toBe(true);
    expect(result.ref).toBe("refs/heads/guidance-thr_abc123");
    expect(await gitLine(canonical, ["show", "guidance-thr_abc123:.bb/AGENTS.md"])).toBe("learned something");
    // The default branch is reviewed like code: the branch is where it stops.
    expect(await gitLine(canonical, ["rev-parse", "HEAD"])).toBe(before);
    expect(await gitLine(canonical, ["show", "HEAD:.bb/AGENTS.md"])).toBe("before");
  });

  it("reports that a lesson needs a pull request instead of fast-forwarding", async () => {
    const { canonical } = await pair();
    const result = await mergeGuidance(canonical, "thr_lesson", ".bb/AGENTS.md", "a lesson");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/pull request/u);
  });

  it("commits the workspace's uncommitted .bb edits before publishing (standalone)", async () => {
    const canonical = path.join(scratch, "standalone-canonical");
    await mkdir(canonical, { recursive: true });
    await bootstrapProjectSource(canonical, EMPTY_REPOS);
    const workspaceBb = path.join(scratch, "standalone-workspace-bb");
    await git(["clone", "--quiet", canonical, workspaceBb]);
    await writeFile(path.join(workspaceBb, "AGENTS.md"), "edited but not committed\n", "utf8");

    const result = await pushGuidance(canonical, workspaceBb, "thr_uncommitted");
    expect(result.ok).toBe(true);
    expect(await gitLine(canonical, ["show", "guidance-thr_uncommitted:AGENTS.md"])).toBe("edited but not committed");
  });
});

describe("adopting a standalone .bb into a primary repo", () => {
  async function standalone(): Promise<string> {
    const dir = path.join(scratch, "standalone");
    await mkdir(dir, { recursive: true });
    await bootstrapProjectSource(dir, EMPTY_REPOS);
    await gitIn(dir, ["config", "user.email", "test@example.invalid"]);
    await gitIn(dir, ["config", "user.name", "Test"]);
    await writeFile(path.join(dir, "AGENTS.md"), "project conventions\n", "utf8");
    await gitIn(dir, ["add", "-A"]);
    await gitIn(dir, ["commit", "--quiet", "-m", "conventions"]);
    return dir;
  }

  it("copies the tree to .bb/ on a branch, then reports already-adopted after the merge", async () => {
    const source = await standalone();
    const primary = await makeRepo("primary");
    const primaryPath = path.join(scratch, "primary-clone");

    const first = await adoptProjectSource({
      standalonePath: source,
      primaryUrl: primary,
      primaryPath,
      branch: "bb/adopt-bb-test",
      openPullRequest: false,
    });
    expect(first.status).toBe("pull-request");
    // The tree is on the branch, and the default branch is untouched.
    expect(await gitLine(primaryPath, ["show", "bb/adopt-bb-test:.bb/AGENTS.md"])).toBe("project conventions");
    expect(await gitLine(primaryPath, ["show", "bb/adopt-bb-test:.bb/repos.json"])).toContain('"repos"');
    expect(await gitLine(primaryPath, ["show", "main:.bb/AGENTS.md"])).toBeNull();

    // Simulate the pull request merging.
    await gitIn(primaryPath, ["checkout", "--quiet", "main"]);
    await gitIn(primaryPath, ["merge", "--ff-only", "--quiet", "bb/adopt-bb-test"]);

    const second = await adoptProjectSource({
      standalonePath: source,
      primaryUrl: primary,
      primaryPath,
      branch: "bb/adopt-bb-again",
      openPullRequest: false,
    });
    expect(second.status).toBe("already");
    expect(second.primaryPath).toBe(primaryPath);
  });

  it("is idempotent: a second run finds .bb/ and copies nothing", async () => {
    const source = await standalone();
    const primary = await makeRepo("primary");
    await commitDefinition(primary, "already here\n");
    const primaryPath = path.join(scratch, "primary-clone");

    const result = await adoptProjectSource({
      standalonePath: source,
      primaryUrl: primary,
      primaryPath,
      branch: "bb/adopt-bb-test",
      openPullRequest: false,
    });
    expect(result.status).toBe("already");
    expect(await gitLine(primaryPath, ["show", "main:.bb/AGENTS.md"])).toBe("already here");
  });
});

describe("seeding a new primary project", () => {
  it("seeds .bb/ on the default branch and publishes a seed branch", async () => {
    const primary = await makeRepo("primary");
    const path_ = path.join(scratch, "primary-clone");
    const result = await preparePrimaryProjectSource({
      url: primary,
      path: path_,
      seed: { version: 1, repos: [{ dir: "other", url: "https://example.com/other", inferredDir: true }] },
      branch: "bb/seed-bb-test",
      openPullRequest: false,
    });
    expect(result.ok).toBe(true);
    expect(result.layout).toBe("primary");
    expect(result.seeded).toBe(true);
    // On the default branch so the first thread can provision...
    expect(await gitLine(path_, ["show", "main:.bb/repos.json"])).toContain("other");
    // ...and published for review on a branch.
    expect(await gitLine(path_, ["show", "bb/seed-bb-test:.bb/AGENTS.md"])).not.toBeNull();
  });

  it("uses a repo that already carries .bb/ as it is", async () => {
    const primary = await makeRepo("primary");
    await commitDefinition(primary, "existing\n");
    const path_ = path.join(scratch, "primary-clone");
    const result = await preparePrimaryProjectSource({
      url: primary,
      path: path_,
      seed: EMPTY_REPOS,
      branch: "bb/seed-bb-test",
      openPullRequest: false,
    });
    expect(result.layout).toBe("primary");
    expect(result.seeded).toBe(false);
  });

  it("provisions before the seed pull request has merged, from the canonical checkout", async () => {
    const primary = await makeRepo("primary");
    const canonical = path.join(scratch, "primary-clone");
    const dir = dirFromUrl(primary) ?? "primary";
    const seeded = await preparePrimaryProjectSource({
      url: primary,
      path: canonical,
      seed: EMPTY_REPOS,
      branch: "bb/seed-bb-test",
      openPullRequest: false,
    });
    expect(seeded.seeded).toBe(true);

    const result = await provisionWorkspace({
      dataDir,
      pathKey: "thread1",
      projectSourcePath: canonical,
      layout: "primary",
      primaryDir: dir,
      repos: [{ dir, url: primary, branch: null }],
      branchName: "dylan/work",
      fetchTtlMs: 0,
      mirrors: [],
    });
    const source = result.repos.find((repo) => repo.dir === ".bb");
    expect(source?.status).toBe("ready");
    expect(await exists(path.join(result.root, ".bb", "AGENTS.md"))).toBe(true);
  });

  it("seeds a checkout sitting on a feature branch without touching it or pushing its work", async () => {
    const primary = await makeRepo("primary");
    const checkout = path.join(scratch, "primary-clone");
    await git(["clone", "--quiet", primary, checkout]);
    await gitIn(checkout, ["config", "user.email", "test@example.invalid"]);
    await gitIn(checkout, ["config", "user.name", "Test"]);
    await gitIn(checkout, ["checkout", "--quiet", "-b", "feature"]);
    await writeFile(path.join(checkout, "wip.txt"), "unpushed work\n", "utf8");
    await gitIn(checkout, ["add", "-A"]);
    await gitIn(checkout, ["commit", "--quiet", "-m", "wip"]);

    const result = await preparePrimaryProjectSource({
      url: primary,
      path: checkout,
      seed: EMPTY_REPOS,
      branch: "bb/seed-bb-test",
      openPullRequest: false,
    });
    expect(result.ok).toBe(true);
    // The seed is on its branch and on the local default branch...
    expect(await gitLine(checkout, ["show", "bb/seed-bb-test:.bb/repos.json"])).toContain('"repos"');
    expect(await gitLine(checkout, ["show", "main:.bb/repos.json"])).toContain('"repos"');
    // ...not on the feature branch, and the feature branch's WIP is not on the seed.
    expect(await gitLine(checkout, ["show", "feature:.bb/repos.json"])).toBeNull();
    expect(await gitLine(checkout, ["show", "bb/seed-bb-test:wip.txt"])).toBeNull();
    expect(await gitLine(checkout, ["show", "feature:wip.txt"])).toBe("unpushed work");
    expect(await gitLine(checkout, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature");
  });
});

describe("the default-branch ref", () => {
  it("uses origin/main when origin/HEAD is absent rather than the checked-out branch", async () => {
    const remote = await makeRepo("primary");
    await commitDefinition(remote);
    const checkout = path.join(scratch, "primary-clone");
    await git(["clone", "--quiet", remote, checkout]);
    await gitIn(checkout, ["config", "user.email", "test@example.invalid"]);
    await gitIn(checkout, ["config", "user.name", "Test"]);
    await gitIn(checkout, ["remote", "set-head", "origin", "-d"]);
    await gitIn(checkout, ["checkout", "--quiet", "-b", "feature"]);

    expect(await resolveDefaultBranchRef(checkout)).toBe("refs/heads/main");
  });
});

/**
 * `create()`'s seeding fallback (BB-137): a primary-layout project with an
 * empty `repos.json` is a complete definition, not a project with nothing
 * configured, so `create()` must not invent repos from the checkouts next to
 * it. Only a standalone `.bb` project is seeded, and the project source's own
 * origin is never proposed into the file either.
 *
 * Driven through the provider with a fake host so the assertion is about the
 * calls `create()` makes — no seed write, and only the primary handed to
 * `provisionWorkspace` — not about a stubbed host's filesystem.
 */
describe("seeding an empty repo set", () => {
  const HOST_ID = "host-seed";
  const PROJECT_ID = "proj_seed";
  const THREAD_ID = "thr_seed";
  const SOURCE_PATH = "/checkouts/primary";
  const ROOT = "/data/workspaces/thr_seed";
  const PRIMARY_URL = "git@github.com:you/primary.git";
  const SIBLING_URL = "git@github.com:you/sibling.git";

  const PROJECT: PluginEnvironmentProviderCreateContext["project"] = {
    id: PROJECT_ID,
    kind: "standard",
    name: "primary",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const THREAD = makeThreadResponse({ id: THREAD_ID, projectId: PROJECT_ID, environmentId: null });

  function hostResponder(layout: "primary" | "standalone", remote: string | null) {
    return (call: { method: string; input: unknown }): unknown => {
      switch (call.method) {
        case "prepareProjectSource":
          return {
            bootstrapped: false,
            reposJson: '{"version":1,"repos":[]}',
            remote,
            defaultBranch: "main",
            layout,
            warnings: [],
          };
        case "discoverCheckouts":
          return {
            checkouts: [
              { path: "/home/dev/projects/sibling", url: SIBLING_URL },
              { path: "/home/dev/projects/primary", url: PRIMARY_URL },
            ],
          };
        case "writeProjectSourceRepos":
          return { committed: true, head: "seed", message: null };
        case "provisionWorkspace":
          return {
            root: ROOT,
            repos: [
              {
                dir: "primary",
                path: `${ROOT}/primary`,
                branch: "bb/work",
                baseBranch: "main",
                remote: PRIMARY_URL,
                status: "ready" as const,
              },
              {
                dir: ".bb",
                path: `${ROOT}/.bb`,
                branch: "main",
                baseBranch: "main",
                remote: PRIMARY_URL,
                status: "ready" as const,
              },
            ],
            definitionBase: null,
          };
        default:
          throw new Error(`unexpected host method ${call.method}`);
      }
    };
  }

  async function runCreate(layout: "primary" | "standalone", remote: string | null) {
    const { bb, harness } = createFakePluginHost({ experimental_callHostRpc: hostResponder(layout, remote) });
    harness.sdk.stub("projects.list", () => []);
    harness.sdk.stub("projects.get", () => PROJECT);
    harness.sdk.stub("system.config", () => ({ primaryHostId: HOST_ID }));
    await plugin(bb);

    const provider = harness.registrations.environmentProviders.get(ENVIRONMENT_PROVIDER_ID);
    if (provider === undefined) throw new Error("Provider not registered");
    const report: PluginEnvironmentProviderProgress = { step: () => undefined, log: () => undefined };
    const result = await provider.create({
      thread: THREAD,
      project: PROJECT,
      host: makeHostResponse({ id: HOST_ID, name: "Fake machine" }),
      projectCheckout: { path: SOURCE_PATH, experimental_ownsPath: false },
      gitRemote: null,
      inputs: null,
      suggestedBranchName: "bb/work",
      attempt: 1,
      pathKey: THREAD_ID,
      experimental_claimPath: async () => true,
      report,
      signal: new AbortController().signal,
    });
    return { result, harness };
  }

  it("primary layout with an empty repos.json seeds nothing and holds only the primary", async () => {
    const { result, harness } = await runCreate("primary", PRIMARY_URL);

    expect(result).toMatchObject({ status: "created", path: ROOT });
    // No seed commit: the definition is left exactly as the owner wrote it.
    expect(harness.experimental_hostRpcCalls.some((call) => call.method === "writeProjectSourceRepos")).toBe(false);

    const provision = harness.experimental_hostRpcCalls.find((call) => call.method === "provisionWorkspace");
    const repos = (provision?.input as { repos: { dir: string; url: string }[] }).repos;
    expect(repos.map((repo) => repo.dir)).toEqual(["primary"]);
    expect(repos.some((repo) => repo.url === SIBLING_URL)).toBe(false);
  });

  it("standalone layout still seeds, and skips the project source's own origin", async () => {
    const { result, harness } = await runCreate("standalone", PRIMARY_URL);

    expect(result).toMatchObject({ status: "created", path: ROOT });
    const write = harness.experimental_hostRpcCalls.find((call) => call.method === "writeProjectSourceRepos");
    expect(write).toBeDefined();
    const reposJson = (write?.input as { reposJson: string }).reposJson;
    // The sibling checkout is proposed...
    expect(reposJson).toContain("sibling");
    // ...but the project source's own origin is not repeated in the file.
    expect(reposJson).not.toContain(PRIMARY_URL);
  });
});
