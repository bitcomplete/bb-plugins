// The project-source seam: how stewards reads a project's `.bb` and how it
// spawns a fresh environment. Two implementations, chosen once per project at
// config load and cached with the config (server.ts):
//
//   * `multi-repo` — the three RPCs, exactly as before: `readProjectFiles`,
//     `repoSet`, `mergeGuidance`. Every project that has the plugin installed
//     stays here, so nothing changes for them.
//   * `native` — a git handler in the plugin's host entry (host.ts,
//     project-git.ts) that reads `.bb` from `origin/<default>` after a fetch,
//     never the developer's working tree, and takes the repo set from the
//     checkout's own `origin`. It is chosen only when the multi-repo RPC
//     reports the plugin is missing (`isMissingPlugin`), so a single-repo
//     project on a stock bb install can run stewards.
//
// A source carries the environment choice too: multi-repo spawns a fresh
// thread on the `multi-repo-workspace` provider when the project has a
// machine, native always leaves it to core (`project-default`). Wake text,
// the stewards skill and `bb stewards spawn-flags` all read the same seam, so
// they cannot disagree with what the plugin actually spawns.
//
// `mergeGuidance` is unsupported natively under BB-107; a lesson that would
// have fast-forwarded the canonical checkout reports that it needs a pull
// request instead (BB-108 already lands lessons as pull requests).
import { isMissingPlugin } from "./source-contract.js";

export const MULTI_REPO_PLUGIN_ID = "multi-repo";
/** multi-repo's environment provider: where every thread of a multi-repo project works. */
export const MULTI_REPO_ENVIRONMENT_PROVIDER_ID = "multi-repo-workspace";

export type ProjectSourceKind = "multi-repo" | "native";

/** A fresh environment for a spawn, as `bb.sdk.threads.spawn` takes it. */
export type FreshEnvironment =
  | { type: "project-default" }
  | { type: "provider"; environmentProviderId: string; inputs: null; machine: { type: "existing"; hostId: string } };

/** The repo set a project source returns, the shape both implementations share. */
export type ProjectRepoSet = {
  repos: Array<{ dir: string; url: string }>;
  /** The project source's own origin, for a lesson's pull request (BB-108). */
  primary: { dir: string; url: string } | null;
  layout: "primary" | "standalone";
  error: string | null;
};

/** One file read from the project's `.bb` at the default branch's tip. */
export type ProjectGitFile = { path: string; content: string | null };

/** What a native host read returns: the files, and enough about the checkout for the repo set. */
export type NativeGitRead = {
  head: string | null;
  files: ProjectGitFile[];
  remote: string | null;
  defaultBranch: string | null;
  layout: "primary" | "standalone";
  error: string | null;
};

export type MergeGuidanceResult = { ok: boolean; sha: string | null; branch: string | null; message: string };

/**
 * One project's source. `readFiles` and `repoSet` are what server.ts reads
 * configuration and guidance through; `freshEnvironment` and
 * `environmentFlags` are how a spawn (and the command a wake shows) is built.
 */
export type ProjectSource = {
  kind: ProjectSourceKind;
  readFiles(paths: string[]): Promise<Map<string, string | null>>;
  repoSet(): Promise<ProjectRepoSet>;
  mergeGuidance(threadId: string, file: string, text: string): Promise<MergeGuidanceResult>;
  freshEnvironment(hostId: string | null): FreshEnvironment;
  environmentFlags(hostId: string | null): string;
};

export type MultiRepoOps = {
  readFiles(paths: string[]): Promise<Map<string, string | null>>;
  repoSet(): Promise<ProjectRepoSet>;
  mergeGuidance(threadId: string, file: string, text: string): Promise<MergeGuidanceResult>;
};

/** The multi-repo environment for a spawn: the workspace provider on the project's machine. */
export const multiRepoFreshEnvironment = (hostId: string | null): FreshEnvironment =>
  hostId === null
    ? { type: "project-default" }
    : { type: "provider", environmentProviderId: MULTI_REPO_ENVIRONMENT_PROVIDER_ID, inputs: null, machine: { type: "existing", hostId } };

/** The same as `bb thread spawn` flags, for the worker command a wake shows. */
export const multiRepoEnvironmentFlags = (hostId: string | null): string =>
  hostId === null ? "" : `--environment-provider ${MULTI_REPO_ENVIRONMENT_PROVIDER_ID} --machine ${hostId}`;

/** The multi-repo implementation: the RPCs as they always were. */
export function multiRepoSource(ops: MultiRepoOps): ProjectSource {
  return {
    kind: "multi-repo",
    readFiles: ops.readFiles,
    repoSet: ops.repoSet,
    mergeGuidance: ops.mergeGuidance,
    freshEnvironment: multiRepoFreshEnvironment,
    environmentFlags: multiRepoEnvironmentFlags,
  };
}

export type NativeOps = {
  readFiles(paths: string[]): Promise<Map<string, string | null>>;
  repoSet(): Promise<ProjectRepoSet>;
};

/** The native implementation: git on the checkout, and core's default environment. */
export function nativeSource(ops: NativeOps): ProjectSource {
  return {
    kind: "native",
    readFiles: ops.readFiles,
    repoSet: ops.repoSet,
    mergeGuidance: async () => ({ ok: false, sha: null, branch: null, message: "A native project has no guidance merge; land the lesson as a pull request." }),
    freshEnvironment: () => ({ type: "project-default" }),
    environmentFlags: () => "",
  };
}

/** A short human label for a project source, for `bb stewards show`/`check` and the Stewards page. */
export const projectSourceLabel = (kind: ProjectSourceKind | null): string =>
  kind === null ? "unknown" : kind === "native" ? "native git (origin's default branch)" : "multi-repo plugin";

/**
 * Whether an RPC failure means the multi-repo plugin is not installed (so
 * native is the right source) rather than that it is installed and failing.
 * Re-exported so server.ts and tests share one rule.
 */
export const sourceRpcMissing = (error: unknown): boolean => isMissingPlugin(error);
