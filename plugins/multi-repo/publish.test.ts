/**
 * BB-148 deliverable 2: the publish policy, end to end against real git repos.
 *
 * Every committed `.bb` write goes through one `publishDefinition` step.
 * `push` puts the default branch on `origin`; `pull-request` puts a
 * `guidance-` branch there and opens a pull request without moving the
 * default branch. The defaults follow the layout, a `publish` key overrides
 * them, and a rejected push or a failed `gh pr create` keeps the local commit
 * and never force-pushes or resets the default branch.
 *
 * `gh` is faked on `PATH`, because the assertions are about what git and the
 * host were asked to do, not about GitHub. The structured-write wiring is
 * checked at the RPC boundary with a fake host.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { git, gitIn, gitLine } from "./git.js";
import { parseReposFile } from "./repos.js";
import { mergeGuidance, pushGuidance, writeReposJson } from "./source.js";
import plugin from "./server.js";

let scratch: string;
let previousPath: string | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "multi-repo-publish-"));
  previousPath = process.env.PATH;
});

afterEach(async () => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  await rm(scratch, { recursive: true, force: true });
});

async function makeBareRemote(name: string): Promise<string> {
  const work = path.join(scratch, "seed-work", name);
  await mkdir(work, { recursive: true });
  await git(["init", "--quiet", "--initial-branch=main", work]);
  await gitIn(work, ["config", "user.email", "test@example.invalid"]);
  await gitIn(work, ["config", "user.name", "Test"]);
  await writeFile(path.join(work, "README.md"), `# ${name}\n`, "utf8");
  await gitIn(work, ["add", "-A"]);
  await gitIn(work, ["commit", "--quiet", "-m", "initial"]);
  const bare = path.join(scratch, "remotes", `${name}.git`);
  await git(["clone", "--quiet", "--bare", work, bare]);
  return bare;
}

/** Clone `remote` into a standalone `.bb` checkout with a committed definition. */
async function makeStandalone(remote: string, name: string, policy?: unknown): Promise<string> {
  const dir = path.join(scratch, name);
  await git(["clone", "--quiet", remote, dir]);
  await gitIn(dir, ["config", "user.email", "test@example.invalid"]);
  await gitIn(dir, ["config", "user.name", "Test"]);
  const file = { version: 1, repos: [], ...(policy === undefined ? {} : { publish: policy }) };
  await writeFile(path.join(dir, "repos.json"), `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await writeFile(path.join(dir, "AGENTS.md"), "# guidance\n", "utf8");
  await gitIn(dir, ["add", "-A"]);
  await gitIn(dir, ["commit", "--quiet", "-m", "seed definition"]);
  await gitIn(dir, ["push", "--quiet", "origin", "main"]);
  return dir;
}

/** Clone `remote` into a primary checkout whose default branch carries `.bb/`. */
async function makePrimary(remote: string, name: string): Promise<string> {
  const dir = path.join(scratch, name);
  await git(["clone", "--quiet", remote, dir]);
  await gitIn(dir, ["config", "user.email", "test@example.invalid"]);
  await gitIn(dir, ["config", "user.name", "Test"]);
  await mkdir(path.join(dir, ".bb", "skills"), { recursive: true });
  await writeFile(path.join(dir, ".bb", "repos.json"), '{"version":1,"repos":[]}\n', "utf8");
  await writeFile(path.join(dir, ".bb", "AGENTS.md"), "# primary guidance\n", "utf8");
  await gitIn(dir, ["add", "-A"]);
  await gitIn(dir, ["commit", "--quiet", "-m", "add .bb"]);
  await gitIn(dir, ["push", "--quiet", "origin", "main"]);
  return dir;
}

/** Put a fake `gh` on PATH; `body` is a POSIX shell script. */
async function installFakeGh(body: string): Promise<void> {
  const bin = path.join(scratch, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "gh"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
}

const GH_CREATE_OK = `if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.com/you/bb/pull/7"; exit 0; fi
exit 1`;

const NEW_REPOS = `{"version":1,"repos":[{"dir":"added","url":"https://example.com/added"}]}\n`;

/** The repos.json text for a write, with an optional publish policy. */
function reposText(policy?: unknown): string {
  return `${JSON.stringify({
    version: 1,
    repos: [{ dir: "added", url: "https://example.com/added" }],
    ...(policy === undefined ? {} : { publish: policy }),
  })}\n`;
}

/**
 * Write through `writeReposJson` the way the server does: the policy is the
 * one parsed out of the text being written, not a separate out-of-band value.
 */
async function writeByPolicy(
  dir: string,
  text: string,
  layout: "standalone" | "primary",
): Promise<Awaited<ReturnType<typeof writeReposJson>>> {
  const parsed = parseReposFile(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return writeReposJson(dir, text, "Add added", undefined, layout, parsed.value.publish);
}

describe("push (standalone default)", () => {
  it("commits on the default branch and pushes it to origin", async () => {
    const remote = await makeBareRemote("push-remote");
    const dir = await makeStandalone(remote, "push-canonical");
    const result = await writeByPolicy(dir, NEW_REPOS, "standalone");
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("push");
    const local = await gitLine(dir, ["rev-parse", "HEAD"]);
    expect(await gitLine(remote, ["rev-parse", "main"])).toBe(local);
    expect(await gitLine(dir, ["show", "HEAD:repos.json"])).toContain('"added"');
  });

  it("keeps the local commit and leaves origin alone when the push is rejected", async () => {
    const remote = await makeBareRemote("reject-remote");
    const dir = await makeStandalone(remote, "reject-canonical");
    const before = await gitLine(remote, ["rev-parse", "main"]);
    // A remote that cannot be reached rejects the push. Nothing may force the
    // push through, and nothing may reset the local commit.
    await gitIn(dir, ["remote", "set-url", "origin", path.join(scratch, "does-not-exist.git")]);
    const result = await writeByPolicy(dir, NEW_REPOS, "standalone");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/pushing it to origin failed/u);
    expect(await gitLine(dir, ["show", "HEAD:repos.json"])).toContain('"added"');
    expect(await gitLine(remote, ["rev-parse", "main"])).toBe(before);
  });

  it("commits locally and reports a note when the project has no origin", async () => {
    const dir = path.join(scratch, "local-only");
    await mkdir(dir, { recursive: true });
    await git(["init", "--quiet", "--initial-branch=main", dir]);
    await gitIn(dir, ["config", "user.email", "test@example.invalid"]);
    await gitIn(dir, ["config", "user.name", "Test"]);
    await writeFile(path.join(dir, "repos.json"), '{"version":1,"repos":[]}\n', "utf8");
    await gitIn(dir, ["add", "-A"]);
    await gitIn(dir, ["commit", "--quiet", "-m", "seed"]);
    const result = await writeByPolicy(dir, NEW_REPOS, "standalone");
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("push");
    expect(result.message).toMatch(/No origin remote/u);
    expect(await gitLine(dir, ["show", "HEAD:repos.json"])).toContain('"added"');
  });
});

describe("pull-request (primary default and standalone override)", () => {
  it("opens a pull request from a guidance branch without moving the default branch (primary)", async () => {
    await installFakeGh(GH_CREATE_OK);
    const remote = await makeBareRemote("primary-remote");
    const dir = await makePrimary(remote, "primary-canonical");
    const beforeLocal = await gitLine(dir, ["rev-parse", "main"]);
    const beforeOrigin = await gitLine(remote, ["rev-parse", "main"]);
    const result = await writeByPolicy(dir, NEW_REPOS, "primary");
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("pull-request");
    expect(result.prUrl).toBe("https://github.com/you/bb/pull/7");
    expect(await gitLine(dir, ["rev-parse", "main"])).toBe(beforeLocal);
    expect(await gitLine(remote, ["rev-parse", "main"])).toBe(beforeOrigin);
    expect(await gitLine(remote, ["show", "guidance-repos-json:.bb/repos.json"])).toContain('"added"');
  });

  it("honours a whole-project pull-request override in a standalone repo", async () => {
    await installFakeGh(GH_CREATE_OK);
    const remote = await makeBareRemote("standalone-pr-remote");
    const dir = await makeStandalone(remote, "standalone-pr-canonical", "pull-request");
    const beforeOrigin = await gitLine(remote, ["rev-parse", "main"]);
    const result = await writeByPolicy(dir, reposText("pull-request"), "standalone");
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("pull-request");
    expect(await gitLine(remote, ["rev-parse", "main"])).toBe(beforeOrigin);
    expect(await gitLine(remote, ["show", "guidance-repos-json:repos.json"])).toContain('"added"');
  });

  it("honours a push override in a primary repo", async () => {
    const remote = await makeBareRemote("primary-push-remote");
    const dir = await makePrimary(remote, "primary-push-canonical");
    const result = await writeByPolicy(dir, reposText("push"), "primary");
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("push");
    expect(await gitLine(remote, ["show", "main:.bb/repos.json"])).toContain('"added"');
  });

  it("keeps the commit and does not move the default branch when the PR cannot be opened", async () => {
    await installFakeGh(`if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi
echo "gh: pull request creation failed" >&2
exit 1`);
    const remote = await makeBareRemote("pr-fail-remote");
    const dir = await makeStandalone(remote, "pr-fail-canonical", "pull-request");
    const beforeLocal = await gitLine(dir, ["rev-parse", "main"]);
    const beforeOrigin = await gitLine(remote, ["rev-parse", "main"]);
    const result = await writeByPolicy(dir, reposText("pull-request"), "standalone");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/opening the pull request failed/u);
    // The commit is on the pushed guidance branch, locally and on origin; the
    // default branch is exactly where it was.
    expect(await gitLine(dir, ["show", "guidance-repos-json:repos.json"])).toContain('"added"');
    expect(await gitLine(remote, ["show", "guidance-repos-json:repos.json"])).toContain('"added"');
    expect(await gitLine(dir, ["rev-parse", "main"])).toBe(beforeLocal);
    expect(await gitLine(remote, ["rev-parse", "main"])).toBe(beforeOrigin);
  });

  it("keeps the branch commit and fails clearly when a pull-request project has no origin", async () => {
    const dir = path.join(scratch, "pr-local-only");
    await mkdir(dir, { recursive: true });
    await git(["init", "--quiet", "--initial-branch=main", dir]);
    await gitIn(dir, ["config", "user.email", "test@example.invalid"]);
    await gitIn(dir, ["config", "user.name", "Test"]);
    await writeFile(path.join(dir, "repos.json"), '{"version":1,"repos":[]}\n', "utf8");
    await gitIn(dir, ["add", "-A"]);
    await gitIn(dir, ["commit", "--quiet", "-m", "seed"]);
    const result = await writeByPolicy(dir, reposText("pull-request"), "standalone");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no origin remote/u);
    expect(await gitLine(dir, ["show", "guidance-repos-json:repos.json"])).toContain('"added"');
  });

  it("returns the open pull request when the branch already has one", async () => {
    await installFakeGh(`if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo '[{"url":"https://github.com/you/bb/pull/9"}]'; exit 0; fi
echo "should not create" >&2
exit 1`);
    const remote = await makeBareRemote("pr-existing-remote");
    const dir = await makeStandalone(remote, "pr-existing-canonical", "pull-request");
    const result = await writeByPolicy(dir, reposText("pull-request"), "standalone");
    expect(result.ok).toBe(true);
    expect(result.prUrl).toBe("https://github.com/you/bb/pull/9");
  });

  it("stacks a second write on the open branch and fast-forwards it", async () => {
    // `gh` is stateful: after the first create, `pr list` reports the open PR.
    const marker = path.join(scratch, "gh-created");
    await installFakeGh(`if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "${marker}" ]; then echo '[{"url":"https://github.com/you/bb/pull/7"}]'; else echo "[]"; fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  touch "${marker}"
  echo "https://github.com/you/bb/pull/7"
  exit 0
fi
exit 1`);
    const remote = await makeBareRemote("stack-remote");
    const dir = await makeStandalone(remote, "stack-canonical", "pull-request");
    const first = `${JSON.stringify({ version: 1, repos: [{ dir: "one", url: "https://example.com/one" }], publish: "pull-request" })}\n`;
    const second = `${JSON.stringify({
      version: 1,
      repos: [
        { dir: "one", url: "https://example.com/one" },
        { dir: "two", url: "https://example.com/two" },
      ],
      publish: "pull-request",
    })}\n`;
    const r1 = await writeByPolicy(dir, first, "standalone");
    expect(r1.ok).toBe(true);
    expect(r1.prUrl).toBe("https://github.com/you/bb/pull/7");
    const r2 = await writeByPolicy(dir, second, "standalone");
    expect(r2.ok).toBe(true);
    expect(r2.prUrl).toBe("https://github.com/you/bb/pull/7");
    // The second commit descends from the first, so the push is a
    // fast-forward and origin's branch carries both changes.
    expect(r1.head).not.toBeNull();
    expect(r2.head).not.toBeNull();
    const ancestor = await gitIn(remote, ["merge-base", "--is-ancestor", r1.head as string, r2.head as string]);
    expect(ancestor.code).toBe(0);
    expect(await gitLine(remote, ["show", "guidance-repos-json:repos.json"])).toContain('"two"');
    // The default branch is still untouched.
    expect(await gitLine(remote, ["show", "main:repos.json"])).not.toContain('"one"');
  });
});

describe("mergeGuidance by policy", () => {
  async function withGuidance(
    policy: "push" | "pull-request",
  ): Promise<{ canonical: string; remote: string; lesson: string }> {
    const remote = await makeBareRemote(`merge-${policy}-remote`);
    const canonical = await makeStandalone(remote, `merge-${policy}-canonical`, policy);
    const workspace = path.join(scratch, `merge-${policy}-workspace`);
    await git(["clone", "--quiet", canonical, workspace]);
    await gitIn(workspace, ["config", "user.email", "test@example.invalid"]);
    await gitIn(workspace, ["config", "user.name", "Test"]);
    const lesson = `Lesson for ${policy}.`;
    const current = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
    await writeFile(path.join(workspace, "AGENTS.md"), `${current}\n${lesson}\n`, "utf8");
    await gitIn(workspace, ["add", "--", "AGENTS.md"]);
    await gitIn(workspace, ["commit", "--quiet", "-m", "record a lesson"]);
    await pushGuidance(canonical, workspace, "thr_lesson");
    return { canonical, remote, lesson };
  }

  it("pushes the fast-forward under push", async () => {
    const { canonical, remote, lesson } = await withGuidance("push");
    const result = await mergeGuidance(canonical, "thr_lesson", "AGENTS.md", lesson);
    expect(result.ok).toBe(true);
    expect(await gitLine(remote, ["show", "main:AGENTS.md"])).toContain(lesson);
    expect(await gitLine(canonical, ["rev-parse", "HEAD"])).toBe(await gitLine(remote, ["rev-parse", "main"]));
  });

  it("opens a pull request and leaves the default branch alone under pull-request", async () => {
    await installFakeGh(GH_CREATE_OK);
    const { canonical, remote, lesson } = await withGuidance("pull-request");
    const beforeLocal = await gitLine(canonical, ["rev-parse", "main"]);
    const beforeOrigin = await gitLine(remote, ["rev-parse", "main"]);
    const result = await mergeGuidance(canonical, "thr_lesson", "AGENTS.md", lesson);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("https://github.com/you/bb/pull/7");
    expect(await gitLine(canonical, ["rev-parse", "main"])).toBe(beforeLocal);
    expect(await gitLine(remote, ["rev-parse", "main"])).toBe(beforeOrigin);
  });
});

/* ----------------------------------------------- the structured write paths */

const PROJECT_ID = "proj_1";
const HOST_ID = "host-a";
const SOURCE_PATH = "/checkouts/acme";

const PROJECT = {
  id: PROJECT_ID,
  kind: "standard",
  name: "acme",
  gitRemoteUrl: null,
  createdAt: 1,
  updatedAt: 1,
  sources: [
    { id: "src_1", projectId: PROJECT_ID, type: "local_path", hostId: HOST_ID, path: SOURCE_PATH, isDefault: true },
  ],
};

async function setupServer(reposJson: string) {
  const hostCalls: Array<{ method: string; input: unknown }> = [];
  const { bb, harness } = createFakePluginHost({
    experimental_callHostRpc: (call: { method: string; input: unknown }) => {
      hostCalls.push({ method: call.method, input: call.input });
      if (call.method === "prepareProjectSource") {
        return {
          bootstrapped: false,
          reposJson,
          remote: "git@github.com:you/acme.git",
          defaultBranch: "main",
          unpushed: null,
          layout: "standalone",
          warnings: [],
        };
      }
      if (call.method === "writeProjectSourceRepos") {
        return {
          ok: true,
          committed: true,
          head: "abc",
          mode: "pull-request",
          prUrl: "https://github.com/you/acme/pull/1",
          message: null,
        };
      }
      throw new Error(`unexpected host method ${call.method}`);
    },
  });
  harness.sdk.stub("projects.get", () => PROJECT);
  harness.sdk.stub("system.config", () => ({ primaryHostId: HOST_ID }));
  await plugin(bb);
  return { harness, hostCalls };
}

describe("the write paths share the publish step", () => {
  it("passes the file's policy to the host for a structured add", async () => {
    const reposJson = JSON.stringify({
      version: 1,
      repos: [{ dir: "a", url: "https://example.com/a" }],
      publish: "pull-request",
    });
    const { harness, hostCalls } = await setupServer(reposJson);
    const result = (await harness.callRpc("addRepo", {
      projectId: PROJECT_ID,
      repo: { dir: "b", url: "https://example.com/b" },
    })) as { ok: boolean; mode: string | null; prUrl: string | null };
    expect(result).toMatchObject({ ok: true, mode: "pull-request", prUrl: "https://github.com/you/acme/pull/1" });
    const write = hostCalls.find((call) => call.method === "writeProjectSourceRepos");
    expect(write?.input).toMatchObject({ publish: "pull-request", layout: "standalone" });
    const written = parseReposFile((write?.input as { reposJson: string }).reposJson);
    expect(written.ok && written.value.publish).toBe("pull-request");
  });

  it("passes the policy from the edited text to the host for the raw editor", async () => {
    const { harness, hostCalls } = await setupServer('{"version":1,"repos":[]}');
    const edited = JSON.stringify({ version: 1, repos: [], publish: "push" });
    const result = (await harness.callRpc("saveRepoSet", { projectId: PROJECT_ID, reposJson: edited })) as {
      ok: boolean;
      mode: string | null;
    };
    expect(result).toMatchObject({ ok: true, mode: "pull-request" });
    const write = hostCalls.find((call) => call.method === "writeProjectSourceRepos");
    expect(write?.input).toMatchObject({ publish: "push" });
  });

  it("passes the policy to the host for a base-branch change", async () => {
    const reposJson = JSON.stringify({
      version: 1,
      repos: [{ dir: "a", url: "https://example.com/a" }],
      publish: { "repos.json": "push" },
    });
    const { harness, hostCalls } = await setupServer(reposJson);
    const result = (await harness.callRpc("setRepoBranch", {
      projectId: PROJECT_ID,
      dir: "a",
      branch: "release",
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    const write = hostCalls.find((call) => call.method === "writeProjectSourceRepos");
    expect(write?.input).toMatchObject({ publish: { "repos.json": "push" } });
  });

  it("surfaces a failed publish as an error on the panel RPC", async () => {
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: (call: { method: string; input: unknown }) => {
        if (call.method === "prepareProjectSource") {
          return {
            bootstrapped: false,
            reposJson: '{"version":1,"repos":[]}',
            remote: "git@github.com:you/acme.git",
            defaultBranch: "main",
            unpushed: null,
            layout: "standalone",
            warnings: [],
          };
        }
        if (call.method === "writeProjectSourceRepos") {
          return { ok: false, committed: true, head: "abc", mode: "push", prUrl: null, message: "push rejected" };
        }
        throw new Error(`unexpected host method ${call.method}`);
      },
    });
    harness.sdk.stub("projects.get", () => PROJECT);
    harness.sdk.stub("system.config", () => ({ primaryHostId: HOST_ID }));
    await plugin(bb);
    const result = (await harness.callRpc("addRepo", {
      projectId: PROJECT_ID,
      repo: { dir: "b", url: "https://example.com/b" },
    })) as { ok: boolean; error: string | null };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/push rejected/u);
  });
});
