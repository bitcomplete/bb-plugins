/**
 * Forks, and the binding that keeps them attached to the checkout they
 * inherited.
 *
 * A fork reuses its source thread's environment, so `create()` never runs for
 * it and no second workspace is provisioned. Everything here is about the
 * consequence: a thread that resolved a workspace by its own id saw nothing at
 * all — no diffs, no repo list, no layout block, and a tool error blaming a
 * provider that was not involved.
 */
import type {
  PluginEnvironmentProviderCreateContext,
  PluginEnvironmentProviderProgress,
} from "@get-bb/plugin-sdk/environment-provider";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";
import { ENVIRONMENT_PROVIDER_ID } from "./shared.js";

type Project = PluginEnvironmentProviderCreateContext["project"];
type Thread = ReturnType<typeof makeThreadResponse>;
type HostRpcCall = FakePluginHarness["experimental_hostRpcCalls"][number];

const HOST_ID = "host-a";
const PROJECT_ID = "proj_1";
const SOURCE_THREAD = "thr_source";
const FORK_THREAD = "thr_fork";
const ENVIRONMENT = "env_1";
const SOURCE_PATH = "/checkouts/acme";
const ROOT = "/data/workspaces/thr_source";
const BRANCH = "bb/fix-the-thing";

const PROJECT: Project = {
  id: PROJECT_ID,
  kind: "standard",
  name: "acme",
  gitRemoteUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

const WORKSPACE_REPOS = [
  {
    dir: "bb-dylan",
    path: `${ROOT}/bb-dylan`,
    branch: BRANCH,
    baseBranch: "main",
    remote: "git@github.com:you/bb-dylan.git",
    status: "ready" as const,
  },
  {
    dir: ".bb",
    path: `${ROOT}/.bb`,
    branch: "master",
    baseBranch: "master",
    remote: SOURCE_PATH,
    status: "ready" as const,
  },
];

const CHANGED_FILES = [
  { path: "src/server.ts", status: "modified" as const, oldPath: null, additions: 12, deletions: 3 },
];

function hostResponder(call: HostRpcCall): unknown {
  switch (call.method) {
    case "prepareProjectSource":
      return {
        bootstrapped: false,
        reposJson: JSON.stringify({
          version: 1,
          repos: [{ dir: "bb-dylan", url: "git@github.com:you/bb-dylan.git" }],
        }),
        remote: null,
        defaultBranch: "main",
        layout: "standalone",
        warnings: [],
      };
    case "discoverCheckouts":
      return { checkouts: [] };
    case "provisionWorkspace":
      return { root: ROOT, repos: WORKSPACE_REPOS };
    case "workspaceStatus":
      return {
        repos: WORKSPACE_REPOS.map((repo) => ({
          dir: repo.dir,
          branch: repo.branch,
          ahead: 0,
          behind: 0,
          dirty: 1,
          untracked: 0,
          error: null,
        })),
      };
    case "diffSummary":
      return {
        repos: WORKSPACE_REPOS.map((repo) => ({
          dir: repo.dir,
          baseBranch: repo.baseBranch,
          mergeBase: "abc1234",
          files: CHANGED_FILES,
          truncated: false,
          error: null,
        })),
      };
    default:
      throw new Error(`unexpected host method ${call.method}`);
  }
}

/**
 * The environments core would report for these threads. `env_1` is the one the
 * workspace was provisioned under — its instance key is the workspace's path
 * key, which is what resolution matches on.
 */
const ENVIRONMENTS: Record<string, Record<string, unknown>> = {
  env_1: {
    id: "env_1",
    hostId: HOST_ID,
    environmentProviderId: ENVIRONMENT_PROVIDER_ID,
    environmentProviderInstanceKey: SOURCE_THREAD,
  },
  // A fork that was given its own multi-repo environment: ours, but never
  // provisioned, so there is no workspace under its key.
  env_other: {
    id: "env_other",
    hostId: HOST_ID,
    environmentProviderId: ENVIRONMENT_PROVIDER_ID,
    environmentProviderInstanceKey: FORK_THREAD,
  },
  // What a spawned child thread gets in a project: a worktree, not one of ours.
  env_worktree: {
    id: "env_worktree",
    hostId: HOST_ID,
    environmentProviderId: "git-worktree",
    environmentProviderInstanceKey: "thr_child",
  },
};

/** The fork as core makes it: a new id on the source thread's environment. */
function fork(overrides: Partial<Thread> = {}): Thread {
  return makeThreadResponse({
    id: FORK_THREAD,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT,
    sourceThreadId: SOURCE_THREAD,
    originKind: "fork",
    title: "The fork",
    ...overrides,
  });
}

const SOURCE = makeThreadResponse({
  id: SOURCE_THREAD,
  projectId: PROJECT_ID,
  environmentId: ENVIRONMENT,
  title: "The original",
});

async function setup(threads: Thread[] = [SOURCE, fork()]) {
  const { bb, harness } = createFakePluginHost({
    experimental_callHostRpc: hostResponder,
  });
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  harness.sdk.stub("projects.get", () => PROJECT);
  harness.sdk.stub("projects.list", () => []);
  harness.sdk.stub("system.config", () => ({ primaryHostId: HOST_ID }));
  harness.sdk.stub("threads.get", (args: unknown) => {
    const id = (args as { threadId: string }).threadId;
    const thread = byId.get(id);
    if (thread === undefined) throw new Error(`no thread ${id}`);
    const environment = thread.environmentId === null ? null : ENVIRONMENTS[thread.environmentId] ?? null;
    return { ...thread, environment };
  });
  await plugin(bb);
  return { bb, harness, byId };
}

async function provision(harness: FakePluginHarness): Promise<void> {
  const provider = harness.registrations.environmentProviders.get(ENVIRONMENT_PROVIDER_ID);
  if (provider === undefined) throw new Error("Provider not registered");
  const report: PluginEnvironmentProviderProgress = { step: () => undefined, log: () => undefined };
  const result = await provider.create({
    thread: SOURCE,
    project: PROJECT,
    host: makeHostResponse({ id: HOST_ID, name: "Fake machine" }),
    projectCheckout: { path: SOURCE_PATH, experimental_ownsPath: false },
    gitRemote: null,
    inputs: null,
    suggestedBranchName: BRANCH,
    attempt: 1,
    pathKey: SOURCE_THREAD,
    experimental_claimPath: async () => true,
    report,
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({ status: "created", path: ROOT });
}

function instructions(harness: FakePluginHarness, threadId: string): string | null {
  const provider = harness.registrations.instructionProvider;
  if (provider === null) throw new Error("No instruction provider registered");
  return provider({ threadId, projectId: PROJECT_ID });
}

describe("a forked thread keeps its source's workspace", () => {
  it("binds on thread.created, so the fork's first turn carries the layout block", async () => {
    const { harness } = await setup();
    await provision(harness);
    expect(instructions(harness, FORK_THREAD)).toBeNull();

    await harness.emitThreadEvent("thread.created", { thread: fork() });

    const text = instructions(harness, FORK_THREAD);
    expect(text).toContain(`${ROOT}/bb-dylan`);
    expect(text).toContain("This checkout is shared.");
    // The source thread learns about the fork too — it is the one with work in
    // the directory already.
    expect(instructions(harness, SOURCE_THREAD)).toContain("This checkout is shared.");
  });

  it("serves the fork's Changes panel from the shared checkout", async () => {
    const { harness } = await setup();
    await provision(harness);
    await harness.emitThreadEvent("thread.created", { thread: fork() });

    const changes = (await harness.callRpc("changes", { threadId: FORK_THREAD })) as {
      repos: { dir: string; files: unknown[] }[];
    };
    expect(changes.repos.map((repo) => repo.dir)).toEqual(["bb-dylan", ".bb"]);
    expect(changes.repos[0]?.files).toHaveLength(1);
  });

  it("names the other thread in the workspace view", async () => {
    const { harness } = await setup();
    await provision(harness);
    await harness.emitThreadEvent("thread.created", { thread: fork() });

    const view = (await harness.callRpc("workspace", { threadId: FORK_THREAD })) as {
      workspace: { root: string; sharedWith: { threadId: string; title: string | null }[] } | null;
    };
    expect(view.workspace?.root).toBe(ROOT);
    expect(view.workspace?.sharedWith).toEqual([{ threadId: SOURCE_THREAD, title: "The original" }]);
  });

  it("binds lazily when the create event was missed", async () => {
    const { harness } = await setup();
    await provision(harness);

    // No thread.created: the fork's first surface is the panel itself.
    const view = (await harness.callRpc("workspace", { threadId: FORK_THREAD })) as {
      workspace: { root: string } | null;
    };
    expect(view.workspace?.root).toBe(ROOT);
    // And the binding it just wrote is what the synchronous instruction path
    // reads on the next turn.
    expect(instructions(harness, FORK_THREAD)).toContain(`${ROOT}/bb-dylan`);
  });

  it("gives the fork's agent tools the shared workspace", async () => {
    const { harness } = await setup();
    await provision(harness);

    const result = await harness.callAgentTool("workspace_list_repos", {}, { threadId: FORK_THREAD });
    expect(String(result)).toContain(`${ROOT}/bb-dylan`);
  });

  it("refuses a fork that was given its own environment", async () => {
    const detached = fork({ environmentId: "env_other" });
    const { harness } = await setup([SOURCE, detached]);
    await provision(harness);
    await harness.emitThreadEvent("thread.created", { thread: detached });

    expect(instructions(harness, FORK_THREAD)).toBeNull();
    const view = (await harness.callRpc("workspace", { threadId: FORK_THREAD })) as {
      workspace: unknown | null;
    };
    expect(view.workspace).toBeNull();
  });

  it("stops counting a deleted thread as sharing the checkout", async () => {
    const { harness } = await setup();
    await provision(harness);
    await harness.emitThreadEvent("thread.created", { thread: fork() });
    expect(instructions(harness, SOURCE_THREAD)).toContain("This checkout is shared.");

    await harness.emitThreadEvent("thread.deleted", { thread: fork({ deletedAt: 1 }) });
    expect(instructions(harness, SOURCE_THREAD)).not.toContain("This checkout is shared.");
  });
});

describe("a thread with no workspace", () => {
  it("says so without blaming another provider", async () => {
    const stranger = makeThreadResponse({ id: "thr_stranger", projectId: PROJECT_ID });
    const { harness } = await setup([SOURCE, stranger]);
    await provision(harness);

    await expect(
      harness.callAgentTool("workspace_list_repos", {}, { threadId: "thr_stranger" }),
    ).rejects.toThrow(/no multi-repo workspace/i);
    await expect(
      harness.callAgentTool("workspace_list_repos", {}, { threadId: "thr_stranger" }),
    ).rejects.not.toThrow(/different provider/i);
  });

  it("leaves a child thread on another provider's environment alone", async () => {
    // A spawned child gets a git worktree, not a multi-repo workspace. Its
    // environment is real and readable — it is simply not ours.
    const child = makeThreadResponse({
      id: "thr_child",
      projectId: PROJECT_ID,
      environmentId: "env_worktree",
      parentThreadId: SOURCE_THREAD,
    });
    const { harness } = await setup([SOURCE, child]);
    await provision(harness);
    await harness.emitThreadEvent("thread.created", { thread: child });

    expect(instructions(harness, "thr_child")).toBeNull();
    const view = (await harness.callRpc("workspace", { threadId: "thr_child" })) as {
      workspace: unknown | null;
    };
    expect(view.workspace).toBeNull();
    // And the source thread is not told it is sharing anything.
    expect(instructions(harness, SOURCE_THREAD)).not.toContain("This checkout is shared.");
  });
});
