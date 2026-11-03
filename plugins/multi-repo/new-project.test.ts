/**
 * The New project form's URL-first flow (BB-219, simplified in BB-222).
 *
 * Two halves. `probeRemote` is checked against real repositories, because
 * "root repos.json, `.bb/repos.json`, neither, or a local checkout" is a fact
 * about a git tree, not a string shape. `createProject`'s clone/adopt dispatch
 * is checked through the server RPC with a fake host, because what matters is
 * which host calls it makes and where the project ends up pointing, not the
 * filesystem underneath: a remote is cloned, a local checkout is adopted, and
 * nothing is seeded, committed or published on the create path.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GitError, git, gitIn } from "./git.js";
import { probeRemote, probeRemoteError } from "./source.js";
import { rpcContract } from "./contract.js";
import plugin from "./server.js";

let scratch: string;
let dataDir: string;

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

/** A bare clone of `source`, standing in for a network remote. */
async function makeBare(source: string, name: string): Promise<string> {
  const dir = path.join(scratch, "bare", `${name}.git`);
  await mkdir(path.dirname(dir), { recursive: true });
  await git(["clone", "--bare", "--quiet", source, dir]);
  return dir;
}

async function commitFile(dir: string, file: string, content: string): Promise<void> {
  const target = path.join(dir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  await gitIn(dir, ["add", "-A"]);
  await gitIn(dir, ["commit", "--quiet", "-m", `add ${file}`]);
}

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "multi-repo-new-project-"));
  dataDir = path.join(scratch, "host-data");
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("probing a remote", () => {
  it("reads a root repos.json as a standalone .bb repo", async () => {
    const work = await makeRepo("standalone");
    await commitFile(work, "repos.json", '{"version":1,"repos":[]}\n');
    const result = await probeRemote({ dataDir, url: await makeBare(work, "standalone") });
    expect(result.outcome).toBe("standalone");
    expect(result.defaultBranch).toBe("main");
  });

  it("reads .bb/repos.json as a primary repo", async () => {
    const work = await makeRepo("primary");
    await commitFile(work, ".bb/repos.json", '{"version":1,"repos":[]}\n');
    await commitFile(work, ".bb/AGENTS.md", "guidance\n");
    const result = await probeRemote({ dataDir, url: await makeBare(work, "primary") });
    expect(result.outcome).toBe("primary");
    expect(result.defaultBranch).toBe("main");
  });

  it("reads neither as a plain repo", async () => {
    const work = await makeRepo("plain");
    const result = await probeRemote({ dataDir, url: await makeBare(work, "plain") });
    expect(result.outcome).toBe("plain");
    expect(result.defaultBranch).toBe("main");
  });

  it("reports a local checkout as checkout, so it is adopted rather than cloned beside", async () => {
    const checkout = await makeRepo("checkout");
    const result = await probeRemote({ dataDir, url: checkout });
    expect(result.outcome).toBe("checkout");
    // The probe did not create a cache entry for a path it adopted.
    await expect(probeRemote({ dataDir, url: checkout })).resolves.toMatchObject({ outcome: "checkout" });
  });

  it("names the credential cause when a private https remote cannot be read", () => {
    const result = {
      code: 128,
      stdout: "",
      stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      truncated: false,
    };
    const message = probeRemoteError("https://github.com/you/private.git", new GitError("git clone", result));
    expect(message).toMatch(/private/u);
    expect(message).toMatch(/credential/u);
  });

  it("refuses a URL that reads as an option, and a relative local path", async () => {
    await expect(probeRemote({ dataDir, url: "--upload-pack=x" })).rejects.toThrow(/not a git URL/u);
    await expect(probeRemote({ dataDir, url: "~/code/repo" })).rejects.toThrow(/must be absolute/u);
    await expect(probeRemote({ dataDir, url: "./repo" })).rejects.toThrow(/must be absolute/u);
  });
});

describe("createProject's source kinds", () => {
  const HOST_ID = "host-a";
  const PROJECT_PATH = "/home/me/bb/acme";

  const PREPARED_SOURCE = {
    bootstrapped: false,
    reposJson: null,
    remote: null,
    defaultBranch: null,
    unpushed: null,
    layout: "standalone" as const,
    warnings: [],
  };

  function setupServer(probeOutcome: "standalone" | "primary" | "plain" | "checkout") {
    const hostCalls: Array<{ method: string; input: unknown }> = [];
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: (call: { method: string; input: unknown }) => {
        hostCalls.push({ method: call.method, input: call.input });
        switch (call.method) {
          case "probeRemote":
            return { outcome: probeOutcome, defaultBranch: "main", message: `${probeOutcome} on main` };
          case "cloneProjectSource":
            return { ok: true, message: null };
          case "prepareProjectSource":
            return PREPARED_SOURCE;
          default:
            throw new Error(`unexpected host method ${call.method}`);
        }
      },
    });
    harness.sdk.stub("projects.list", () => []);
    harness.sdk.stub("projects.create", () => ({ id: "proj_new", name: "acme" }));
    harness.sdk.stub("system.config", () => ({ primaryHostId: HOST_ID }));
    return { bb, harness, hostCalls };
  }

  it("clones a remote and points the project at the clone, without seeding", async () => {
    const { bb, harness, hostCalls } = setupServer("plain");
    await plugin(bb);
    const result = (await harness.callRpc("createProject", {
      name: "acme",
      hostId: HOST_ID,
      path: PROJECT_PATH,
      source: { kind: "clone", url: "https://example.com/acme.git" },
    })) as { ok: boolean; layout: string | null };
    expect(result).toMatchObject({ ok: true, layout: "standalone" });
    expect(hostCalls.map((call) => call.method)).toEqual(["cloneProjectSource", "prepareProjectSource"]);
    expect(hostCalls.find((call) => call.method === "cloneProjectSource")?.input).toMatchObject({
      url: "https://example.com/acme.git",
      path: PROJECT_PATH,
    });
    // Nothing is seeded, committed or published on the create path.
    expect(hostCalls.some((call) => call.method === "preparePrimaryProjectSource")).toBe(false);
  });

  it("adopts a local checkout as the project source instead of cloning beside it", async () => {
    const { bb, harness, hostCalls } = setupServer("checkout");
    await plugin(bb);
    const checkout = "/home/me/code/acme";
    const result = (await harness.callRpc("createProject", {
      name: "acme",
      hostId: HOST_ID,
      path: "/home/me/bb/acme",
      source: { kind: "checkout", url: checkout },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(hostCalls.map((call) => call.method)).toEqual(["prepareProjectSource"]);
    expect(hostCalls.find((call) => call.method === "prepareProjectSource")?.input).toMatchObject({
      path: checkout,
      bootstrap: false,
    });
    expect(hostCalls.some((call) => call.method === "cloneProjectSource")).toBe(false);
  });

  it("probes host-side for the legacy auto kind and still does not seed", async () => {
    const { bb, harness, hostCalls } = setupServer("standalone");
    await plugin(bb);
    const result = (await harness.callRpc("createProject", {
      name: "acme",
      hostId: HOST_ID,
      path: PROJECT_PATH,
      source: { kind: "auto", url: "https://example.com/acme.bb.git", repos: [], openPullRequest: false },
    })) as { ok: boolean; layout: string | null };
    expect(result).toMatchObject({ ok: true, layout: "standalone" });
    expect(hostCalls.map((call) => call.method)).toEqual([
      "probeRemote",
      "cloneProjectSource",
      "prepareProjectSource",
    ]);
    expect(hostCalls.some((call) => call.method === "preparePrimaryProjectSource")).toBe(false);
  });

  it("still refuses a path another project owns", async () => {
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: () => {
        throw new Error("no host call expected");
      },
    });
    harness.sdk.stub("projects.list", () => [
      {
        id: "proj_other",
        name: "other",
        sources: [{ type: "local_path", hostId: HOST_ID, path: PROJECT_PATH, isDefault: true }],
      },
    ]);
    harness.sdk.stub("projects.create", () => ({ id: "proj_new" }));
    harness.sdk.stub("system.config", () => ({ primaryHostId: HOST_ID }));
    await plugin(bb);
    const result = (await harness.callRpc("createProject", {
      name: "acme",
      hostId: HOST_ID,
      path: PROJECT_PATH,
      source: { kind: "checkout", url: PROJECT_PATH },
    })) as { ok: boolean; error: string | null };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already the source of the project "other"/u);
  });

  it("accepts clone, checkout and the legacy auto kinds, and rejects the removed primary and plain", () => {
    for (const source of [
      { kind: "clone", url: "https://example.com/a.git" },
      { kind: "checkout", url: "/home/me/code/a" },
      { kind: "auto", url: "https://example.com/a.git", repos: [], openPullRequest: true },
    ]) {
      const parsed = rpcContract.createProject.input.safeParse({
        name: "a",
        hostId: HOST_ID,
        path: PROJECT_PATH,
        source,
      });
      expect(parsed.success).toBe(true);
    }
    for (const source of [
      { kind: "primary", url: "https://example.com/a.git", repos: [] },
      { kind: "plain", url: "https://example.com/a.git", repos: [], openPullRequest: false },
    ]) {
      const parsed = rpcContract.createProject.input.safeParse({
        name: "a",
        hostId: HOST_ID,
        path: PROJECT_PATH,
        source,
      });
      expect(parsed.success).toBe(false);
    }
  });
});
