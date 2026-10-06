/**
 * The host entry: everything that touches a filesystem or spawns git.
 *
 * It runs in the BB host worker on the machine that holds the repos, which is
 * the only place `node:fs` and `node:child_process` mean anything, and — just
 * as importantly — is **outside the agent's sandbox**. That is what makes the
 * two inverted writes in this design possible: editing `repos.json` in the
 * canonical `.bb` checkout while the agent is under `accept-edits`, and
 * publishing a thread's guidance commits back to that checkout.
 *
 * Every handler takes the absolute paths it works on in its input. Core does
 * not infer an environment, a cwd, or a lock for host RPC, so nothing here
 * guesses at one.
 */
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals, type RepoTarget } from "./contract.js";
import { cacheStatus, refreshCaches, type CacheProgress } from "./cache.js";
import { discoverCheckouts } from "./discovery.js";
import { filePatch, repoChanges, repoLiveStatus } from "./diff.js";
import { readPullRequests, runPrAction } from "./gh.js";
import { EMPTY_REPOS, resolveRepoEntry, type ReposFile } from "./repos.js";
import type { RepoSeed } from "./contract.js";
import {
  bootstrapProjectSource,
  cloneProjectSource,
  defaultProjectSourcePath,
  projectSourceBranch,
  projectSourceRemote,
  pushGuidance,
  readReposJson,
  refreshProjectSource,
  writeReposJson,
} from "./source.js";
import { addWorkspaceRepo, provisionWorkspace, removeWorkspace } from "./workspace.js";

/**
 * The repo set a fresh `.bb` starts with.
 *
 * Entries are resolved but not validated here: the server validated the set
 * before asking, and an entry whose `dir` cannot be inferred is dropped rather
 * than failing the bootstrap, because a project with one fewer repo is
 * recoverable from the panel and a project with no checkout is not.
 */
function seedFile(seed: readonly RepoSeed[] | undefined): ReposFile {
  if (seed === undefined || seed.length === 0) return EMPTY_REPOS;
  const repos: ReposFile["repos"] = [];
  for (const entry of seed) {
    const resolved = resolveRepoEntry(entry);
    if (resolved !== null) repos.push(resolved);
  }
  return { version: EMPTY_REPOS.version, repos };
}

/**
 * Relay a long call's progress into the launch report.
 *
 * A cold start is a full network clone per repo. Without this the environment
 * sits on one spinner for several minutes and reads as hung — which is the
 * single worst thing a provider can do, because the honest response to a hung
 * launch is to cancel it and lose the clone that was nearly finished.
 */
function progressReporter(
  operationId: string,
  // Taken as a closure rather than as a bare method reference: the context
  // owns `experimental_emitSignal`, and detaching it would drop its receiver.
  emit: (payload: { operationId: string; kind: "step" | "log"; text: string }) => Promise<void>,
): CacheProgress {
  const send = (kind: "step" | "log", text: string) => {
    // Fire-and-forget: progress must never fail or delay the work it describes.
    void emit({ operationId, kind, text: text.slice(0, 2000) }).catch(() => undefined);
  };
  return {
    step: (text) => send("step", text),
    log: (text) => send("log", text),
  };
}

function toTargets(repos: readonly RepoTarget[]): RepoTarget[] {
  return repos.map((repo) => ({ ...repo }));
}

export function createMultiRepoHostEntry() {
  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      async prepareProjectSource(input, context) {
        const warnings: string[] = [];
        const bootstrap = input.bootstrap
          ? await bootstrapProjectSource(input.path, seedFile(input.seed), context.signal)
          : { bootstrapped: false, warnings: [] as string[] };
        warnings.push(...bootstrap.warnings);
        if (!bootstrap.bootstrapped) {
          warnings.push(...(await refreshProjectSource(input.path, input.fetchTtlMs, context.signal)));
        }
        return {
          bootstrapped: bootstrap.bootstrapped,
          reposJson: await readReposJson(input.path),
          remote: await projectSourceRemote(input.path, context.signal),
          defaultBranch: await projectSourceBranch(input.path, context.signal),
          warnings: warnings.slice(0, 20),
        };
      },

      async cloneProjectSource(input, context) {
        return cloneProjectSource(input.url, input.path, context.signal);
      },

      async suggestProjectSourcePath(input) {
        return defaultProjectSourcePath(input.name);
      },

      async writeProjectSourceRepos(input, context) {
        const result = await writeReposJson(input.path, input.reposJson, input.message, context.signal);
        return { committed: result.committed, head: result.head, message: result.message };
      },

      async discoverCheckouts(input, context) {
        const checkouts = await discoverCheckouts({
          paths: input.paths,
          searchRoots: input.searchRoots,
          signal: context.signal,
        });
        return { checkouts: checkouts.slice(0, 500) };
      },

      async provisionWorkspace(input, context) {
        const report = progressReporter(input.operationId, (payload) => context.experimental_emitSignal("progress", payload));
        const result = await provisionWorkspace({
          dataDir: context.experimental_paths.dataDir,
          pathKey: input.pathKey,
          projectSourcePath: input.projectSourcePath,
          repos: input.repos,
          branchName: input.branchName,
          fetchTtlMs: input.fetchTtlMs,
          mirrors: input.mirrors,
          report,
          signal: context.signal,
        });
        return { root: result.root, repos: result.repos };
      },

      async addWorkspaceRepo(input, context) {
        const report = progressReporter(input.operationId, (payload) => context.experimental_emitSignal("progress", payload));
        const repo = await addWorkspaceRepo({
          dataDir: context.experimental_paths.dataDir,
          pathKey: input.pathKey,
          root: input.root,
          repo: input.repo,
          branchName: input.branchName,
          fetchTtlMs: input.fetchTtlMs,
          mirrors: input.mirrors,
          report,
          signal: context.signal,
        });
        return { repo };
      },

      async removeWorkspace(input, context) {
        const report = progressReporter(input.operationId, (payload) => context.experimental_emitSignal("progress", payload));
        return removeWorkspace({
          dataDir: context.experimental_paths.dataDir,
          pathKey: input.pathKey,
          path: input.path,
          report,
          signal: context.signal,
        });
      },

      async refreshCaches(input, context) {
        // The sweep can outlive the call that started it only if the worker is
        // kept alive; it is short enough to simply run inside the call.
        const entries = await refreshCaches(
          context.experimental_paths.dataDir,
          input.repos.map((repo) => repo.url),
          input.maxAgeMs,
          context.signal,
        );
        return { entries };
      },

      async cacheStatus(input, context) {
        const entries = await cacheStatus(
          context.experimental_paths.dataDir,
          input.repos.map((repo) => repo.url),
        );
        return { entries };
      },

      async workspaceStatus(input, context) {
        const repos = [];
        for (const target of toTargets(input.repos)) {
          repos.push(await repoLiveStatus(target, context.signal));
        }
        return { repos };
      },

      async diffSummary(input, context) {
        const repos = [];
        for (const target of toTargets(input.repos)) {
          repos.push(await repoChanges(target, input.maxFiles, context.signal));
        }
        return { repos };
      },

      async diffFile(input, context) {
        return filePatch({
          repoPath: input.repoPath,
          baseBranch: input.baseBranch,
          file: input.file,
          untracked: input.untracked,
          maxBytes: input.maxBytes,
          signal: context.signal,
        });
      },

      async pullRequests(input, context) {
        const repos = await readPullRequests(input.repos, input.branch, context.signal);
        return { repos };
      },

      async pullRequestAction(input, context) {
        return runPrAction({
          repoPath: input.repoPath,
          branch: input.branch,
          action: input.action,
          tempDir: context.experimental_paths.tempDir,
          signal: context.signal,
        });
      },

      async pushGuidance(input, context) {
        return pushGuidance(
          input.projectSourcePath,
          input.workspaceBbPath,
          input.threadId,
          context.signal,
        );
      },
    },
  });
}

export default createMultiRepoHostEntry();
