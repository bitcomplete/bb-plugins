/**
 * The two RPC contracts: server ↔ host, and frontend ↔ server.
 *
 * Both sides of each import this module, so these schemas are the single
 * definition of what crosses the boundary. The host runs on the machine that
 * holds the repos and owns every filesystem and git operation; the server owns
 * storage, the provider registration and the agent surface; the app owns the
 * panels. Nothing is inferred across a boundary — a host method that operates
 * on a directory takes the absolute path in its input, because core does not
 * infer an environment or a cwd for host RPC.
 */
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PROJECT_FILE_PATH_MAX, projectFilePathProblem } from "./names.js";

const absolutePath = z.string().min(1).max(4096);

/** Which of the two project-source shapes a checkout has. */
export const projectLayoutSchema = z.enum(["standalone", "primary"]);
export type ProjectLayoutValue = z.infer<typeof projectLayoutSchema>;

/**
 * Commits on the project checkout's default branch that its origin lacks.
 *
 * Computed host-side at `create()` and carried in the workspace manifest so
 * the synchronous instruction block can print the "unpushed .bb" line. `count`
 * is the true ahead count; `subjects` may be shorter when the log was capped.
 */
export const unpushedSummarySchema = z
  .object({
    /** The default branch the commits sit on, e.g. `main`. */
    branch: z.string().min(1).max(300),
    count: z.number().int().positive(),
    subjects: z.array(z.string().max(2000)).max(50),
  })
  .strict();

export type UnpushedSummary = z.infer<typeof unpushedSummarySchema>;

/**
 * The most text one file in `readProjectFiles` may carry.
 *
 * A file over it is not truncated: half a playbook reads as a whole one. It
 * comes back with `content: null` and the response's `error` names it, so a
 * caller can tell it from a file that is not in the commit at all.
 */
export const PROJECT_FILE_MAX_CHARS = 200_000;
export const PROJECT_FILES_MAX = 50;

/** A file inside the `.bb` repo, as a relative POSIX path. */
export const projectFilePathSchema = z
  .string()
  .min(1)
  .max(PROJECT_FILE_PATH_MAX)
  .superRefine((value, context) => {
    const problem = projectFilePathProblem(value);
    if (problem !== null) context.addIssue({ code: "custom", message: problem });
  });

export const projectFileSchema = z
  .object({
    path: z.string().max(PROJECT_FILE_PATH_MAX),
    /** Null when the commit has no regular file at this path, or it is too large. */
    content: z.string().max(PROJECT_FILE_MAX_CHARS).nullable(),
  })
  .strict();

export const repoStatusSchema = z.enum(["ready", "failed"]);

export const workspaceRepoSchema = z
  .object({
    dir: z.string().min(1).max(100),
    path: absolutePath,
    // Empty is legal on both: a repo that failed to materialize has no branch
    // and no base. Requiring a name here would make the failure path throw at
    // the RPC boundary instead of being reported, which is the opposite of
    // the per-repo failure policy.
    branch: z.string().max(300),
    baseBranch: z.string().max(300),
    remote: z.string().max(2000),
    status: repoStatusSchema,
    message: z.string().max(600).optional(),
  })
  .strict();

/** One repo as `provisionWorkspace` is asked to materialize it. */
export const repoRequestSchema = z
  .object({
    dir: z.string().min(1).max(100),
    url: z.string().min(1).max(2000),
    branch: z.string().min(1).max(300).nullable(),
  })
  .strict();

export type RepoRequest = z.infer<typeof repoRequestSchema>;

/**
 * One repo as a person writes it: `dir` and `branch` optional, resolved later
 * by `resolveRepoEntry`. The shape of a row in the panel's add form and of an
 * entry seeded into a brand-new `repos.json`.
 */
export const repoSeedSchema = z
  .object({
    dir: z.string().min(1).max(100).optional(),
    url: z.string().min(1).max(2000),
    branch: z.string().min(1).max(300).optional(),
  })
  .strict();

export type RepoSeed = z.infer<typeof repoSeedSchema>;

/** A repo the panel or the diff layer already knows the location of. */
export const repoTargetSchema = z
  .object({
    dir: z.string().min(1).max(100),
    path: absolutePath,
    baseBranch: z.string().min(1).max(300),
  })
  .strict();

export type RepoTarget = z.infer<typeof repoTargetSchema>;

export const repoLiveStatusSchema = z
  .object({
    dir: z.string().min(1).max(100),
    /** Null when the directory is gone or is not a git repo. */
    branch: z.string().max(300).nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    /** Tracked files with uncommitted changes, staged or not. */
    dirty: z.number().int().nonnegative(),
    untracked: z.number().int().nonnegative(),
    error: z.string().max(600).nullable(),
  })
  .strict();

export type RepoLiveStatus = z.infer<typeof repoLiveStatusSchema>;

export const changeStatusSchema = z.enum(["added", "modified", "deleted", "renamed", "untracked"]);

export const changedFileSchema = z
  .object({
    path: z.string().min(1).max(4096),
    status: changeStatusSchema,
    /** The pre-rename path, when git reported a rename. */
    oldPath: z.string().max(4096).nullable(),
    /** Null for a binary file, which has no line counts. */
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type ChangedFile = z.infer<typeof changedFileSchema>;

export const repoChangesSchema = z
  .object({
    dir: z.string().min(1).max(100),
    baseBranch: z.string().max(300),
    /** The merge base the files below are measured against; null when unknown. */
    mergeBase: z.string().max(64).nullable(),
    files: z.array(changedFileSchema).max(2000),
    /** True when the repo has more changed files than the cap returned. */
    truncated: z.boolean(),
    error: z.string().max(600).nullable(),
  })
  .strict();

export type RepoChanges = z.infer<typeof repoChangesSchema>;

export const pullRequestSchema = z
  .object({
    number: z.number().int(),
    title: z.string().max(400),
    url: z.string().max(600),
    state: z.string().max(40),
    isDraft: z.boolean(),
    baseRefName: z.string().max(300),
    headRefName: z.string().max(300),
    /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null. */
    reviewDecision: z.string().max(40).nullable(),
    /** `CLEAN`, `BEHIND`, `DIRTY`, `BLOCKED`, `UNSTABLE`, `HAS_HOOKS`, `UNKNOWN`. */
    mergeStateStatus: z.string().max(40),
    mergeable: z.string().max(40).nullable(),
    /** Every `statusCheckRollup` conclusion, uppercased. */
    checks: z
      .array(z.object({ name: z.string().max(200), conclusion: z.string().max(40).nullable() }).strict())
      .max(100),
    reviewRequestCount: z.number().int().nonnegative(),
  })
  .strict();

export type PullRequest = z.infer<typeof pullRequestSchema>;

export const repoPullRequestSchema = z
  .object({
    dir: z.string().min(1).max(100),
    /** Null when the branch has no PR, or when `gh` could not answer. */
    pr: pullRequestSchema.nullable(),
    error: z.string().max(600).nullable(),
  })
  .strict();

export type RepoPullRequest = z.infer<typeof repoPullRequestSchema>;

export const cacheEntrySchema = z
  .object({
    key: z.string().max(200),
    url: z.string().max(2000),
    present: z.boolean(),
    /** Epoch ms of the last successful fetch, or null if never fetched. */
    fetchedAt: z.number().int().nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    error: z.string().max(600).nullable(),
  })
  .strict();

export type CacheEntry = z.infer<typeof cacheEntrySchema>;

export const discoveredCheckoutSchema = z
  .object({ path: absolutePath, url: z.string().min(1).max(2000) })
  .strict();

export type DiscoveredCheckout = z.infer<typeof discoveredCheckoutSchema>;

/* ------------------------------------------------------------------ host */

export const hostContract = defineRpcContract({
  /**
   * Make the canonical `.bb` checkout usable: initialize it when the directory
   * has no `.git`, fetch it when it has a remote and its last fetch is older
   * than the TTL, then read `repos.json`.
   *
   * One call rather than three because all three touch the same directory and
   * the middle one is conditional on the first.
   */
  prepareProjectSource: {
    input: z
      .object({
        path: absolutePath,
        fetchTtlMs: z.number().int().nonnegative(),
        /**
         * Whether an absent `.git` should be initialized.
         *
         * True only on the provisioning path. Merely opening the Repos panel
         * or running `bb repos list` must not `git init` someone's directory
         * as a side effect of a read.
         */
        bootstrap: z.boolean(),
        /**
         * The repo set a bootstrapped `repos.json` starts with. Ignored when
         * the directory is already a repo: nothing here overwrites a file.
         */
        seed: z.array(repoSeedSchema).max(64).optional(),
      })
      .strict(),
    output: z
      .object({
        bootstrapped: z.boolean(),
        /** The file's text, or null when the repo has no `repos.json` yet. */
        reposJson: z.string().max(200_000).nullable(),
        remote: z.string().max(2000).nullable(),
        defaultBranch: z.string().max(300).nullable(),
        /**
         * Commits on the default branch the origin lacks, or null when level.
         * The provider computes this; `readRepoSet` and `create()` carry it.
         */
        unpushed: unpushedSummarySchema.nullable(),
        /** `standalone` (definition at the root) or `primary` (`.bb/`). */
        layout: projectLayoutSchema,
        warnings: z.array(z.string().max(600)).max(20),
      })
      .strict(),
  },

  /**
   * Read files from the canonical checkout's committed `HEAD`.
   *
   * Refreshes first — fetch and fast-forward, at most once per TTL, exactly
   * as `prepareProjectSource` does — then reads each path out of the commit
   * rather than off disk, so an uncommitted edit in the checkout is never
   * served. `head` is the commit read.
   */
  readProjectSourceFiles: {
    input: z
      .object({
        path: absolutePath,
        fetchTtlMs: z.number().int().nonnegative(),
        files: z.array(projectFilePathSchema).min(1).max(PROJECT_FILES_MAX),
      })
      .strict(),
    output: z
      .object({
        head: z.string().max(64).nullable(),
        files: z.array(projectFileSchema).max(PROJECT_FILES_MAX),
        error: z.string().max(2000).nullable(),
        warnings: z.array(z.string().max(600)).max(20),
      })
      .strict(),
  },

  /** Write `repos.json` in the canonical checkout and commit it. */
  writeProjectSourceRepos: {
    input: z
      .object({
        path: absolutePath,
        reposJson: z.string().max(200_000),
        message: z.string().min(1).max(300),
        /** Which layout's definition path to write; defaults to `standalone`. */
        layout: projectLayoutSchema.optional(),
      })
      .strict(),
    output: z
      .object({
        committed: z.boolean(),
        head: z.string().max(64).nullable(),
        /** Why the commit did not happen, when it did not. */
        message: z.string().max(600).nullable(),
      })
      .strict(),
  },

  /**
   * Clone an existing `.bb` repo to become this machine's canonical checkout.
   *
   * The shared way into a project: a teammate's workspace definition from one
   * URL. Refuses a destination that already holds anything, because a clone
   * into a directory with contents is either a mistake or a second project.
   */
  cloneProjectSource: {
    input: z.object({ url: z.string().min(1).max(2000), path: absolutePath }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string().max(600).nullable() }).strict(),
  },

  /**
   * Where a new project's `.bb` checkout would go by default on this machine,
   * and whether something is already there. The panel shows it as an editable
   * suggestion; it decides nothing.
   */
  suggestProjectSourcePath: {
    input: z.object({ name: z.string().min(1).max(300) }).strict(),
    output: z.object({ path: absolutePath, exists: z.boolean() }).strict(),
  },

  /**
   * Read the `origin` of each candidate directory, and of the immediate
   * children of each search root. Used both to find a local mirror to seed the
   * object cache from and to propose a repo set for an empty project.
   */
  discoverCheckouts: {
    input: z
      .object({
        paths: z.array(absolutePath).max(500),
        searchRoots: z.array(absolutePath).max(20),
      })
      .strict(),
    output: z.object({ checkouts: z.array(discoveredCheckoutSchema).max(500) }).strict(),
  },

  /** Clone every repo plus `.bb` into a fresh workspace root. Idempotent per pathKey. */
  provisionWorkspace: {
    input: z
      .object({
        operationId: z.string().min(1).max(200),
        pathKey: z.string().min(1).max(200),
        projectSourcePath: absolutePath,
        /** Which shape the project source has; decides how `.bb/` is materialized. */
        layout: projectLayoutSchema.optional(),
        /** The primary work repo's directory; `.bb/` is copied out of it. */
        primaryDir: z.string().min(1).max(100).nullable().optional(),
        repos: z.array(repoRequestSchema).max(64),
        branchName: z.string().min(1).max(300),
        fetchTtlMs: z.number().int().nonnegative(),
        /** Local checkouts this machine already has, for cache seeding. */
        mirrors: z.array(discoveredCheckoutSchema).max(500),
      })
      .strict(),
    output: z
      .object({
        root: absolutePath,
        repos: z.array(workspaceRepoSchema).max(64),
        /** The default-branch commit `.bb/` was materialized from, or null. */
        definitionBase: z.string().max(64).nullable(),
      })
      .strict(),
  },

  /** Clone one more repo into a workspace that is already live. */
  addWorkspaceRepo: {
    input: z
      .object({
        operationId: z.string().min(1).max(200),
        pathKey: z.string().min(1).max(200),
        root: absolutePath,
        repo: repoRequestSchema,
        branchName: z.string().min(1).max(300),
        fetchTtlMs: z.number().int().nonnegative(),
        mirrors: z.array(discoveredCheckoutSchema).max(500),
      })
      .strict(),
    output: z.object({ repo: workspaceRepoSchema }).strict(),
  },

  removeWorkspace: {
    input: z
      .object({
        operationId: z.string().min(1).max(200),
        pathKey: z.string().min(1).max(200),
        path: absolutePath.nullable(),
      })
      .strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },

  /** Fetch every cache entry older than `maxAgeMs`. The background sweep's call. */
  refreshCaches: {
    input: z
      .object({
        repos: z.array(z.object({ url: z.string().min(1).max(2000) }).strict()).max(200),
        maxAgeMs: z.number().int().nonnegative(),
      })
      .strict(),
    output: z.object({ entries: z.array(cacheEntrySchema).max(200) }).strict(),
  },

  cacheStatus: {
    input: z.object({ repos: z.array(z.object({ url: z.string().min(1).max(2000) }).strict()).max(200) }).strict(),
    output: z.object({ entries: z.array(cacheEntrySchema).max(200) }).strict(),
  },

  workspaceStatus: {
    input: z.object({ repos: z.array(repoTargetSchema).max(64) }).strict(),
    output: z.object({ repos: z.array(repoLiveStatusSchema).max(64) }).strict(),
  },

  diffSummary: {
    input: z
      .object({
        repos: z.array(repoTargetSchema).max(64),
        maxFiles: z.number().int().positive().max(5000),
      })
      .strict(),
    output: z.object({ repos: z.array(repoChangesSchema).max(64) }).strict(),
  },

  diffFile: {
    input: z
      .object({
        repoPath: absolutePath,
        baseBranch: z.string().min(1).max(300),
        file: z.string().min(1).max(4096),
        untracked: z.boolean(),
        maxBytes: z.number().int().positive().max(8 * 1024 * 1024),
      })
      .strict(),
    output: z
      .object({
        patch: z.string().max(8 * 1024 * 1024),
        truncated: z.boolean(),
        error: z.string().max(600).nullable(),
      })
      .strict(),
  },

  pullRequests: {
    input: z
      .object({
        repos: z.array(z.object({ dir: z.string().min(1).max(100), path: absolutePath }).strict()).max(64),
        branch: z.string().min(1).max(300),
      })
      .strict(),
    output: z.object({ repos: z.array(repoPullRequestSchema).max(64) }).strict(),
  },

  pullRequestAction: {
    input: z
      .object({
        repoPath: absolutePath,
        branch: z.string().min(1).max(300),
        action: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("create"),
              title: z.string().min(1).max(300),
              body: z.string().max(60_000),
              base: z.string().min(1).max(300),
              draft: z.boolean(),
            })
            .strict(),
          z.object({ kind: z.literal("ready") }).strict(),
          z
            .object({
              kind: z.literal("merge"),
              method: z.enum(["merge", "squash", "rebase"]),
            })
            .strict(),
          z.object({ kind: z.literal("push") }).strict(),
        ]),
      })
      .strict(),
    output: z
      .object({ ok: z.boolean(), message: z.string().max(2000), url: z.string().max(600).nullable() })
      .strict(),
  },

  /**
   * Publish the workspace's `.bb` commits back to the canonical checkout.
   *
   * Direction is inverted on purpose: the canonical repo is outside the
   * agent's sandbox, so the write is initiated host-side and *pulls* from the
   * workspace. Landing on `refs/heads/guidance-<threadId>` rather than the
   * checked-out branch also sidesteps `receive.denyCurrentBranch`.
   */
  pushGuidance: {
    input: z
      .object({
        projectSourcePath: absolutePath,
        workspaceBbPath: absolutePath,
        threadId: z.string().min(1).max(100),
        /** The default-branch commit the workspace `.bb/` was materialized from. */
        definitionBase: z.string().max(64).nullable().optional(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        ref: z.string().max(300).nullable(),
        message: z.string().max(2000),
      })
      .strict(),
  },

  /**
   * Fast-forward the canonical checkout to a thread's published guidance
   * branch. The narrow merge a self-merged lesson uses; `source.ts` has the
   * refusals. Leaves the branch in place on any refusal.
   */
  mergeGuidance: {
    input: z
      .object({
        projectSourcePath: absolutePath,
        threadId: z.string().min(1).max(100),
        file: projectFilePathSchema,
        text: z.string().min(1).max(20_000),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        sha: z.string().max(64).nullable(),
        branch: z.string().max(300).nullable(),
        message: z.string().max(2000),
      })
      .strict(),
  },

  /**
   * Copy a standalone `.bb` tree into a primary repo as `.bb/` on a branch, or
   * report that it already carries one. Idempotent; never touches the default
   * branch.
   */
  adoptProjectSource: {
    input: z
      .object({
        standalonePath: absolutePath,
        primaryUrl: z.string().min(1).max(2000),
        primaryPath: absolutePath,
        branch: z.string().min(1).max(300),
        openPullRequest: z.boolean(),
      })
      .strict(),
    output: z
      .object({
        status: z.enum(["already", "pull-request", "failed"]),
        message: z.string().max(2000),
        prUrl: z.string().max(600).nullable(),
        warnings: z.array(z.string().max(600)).max(20),
        primaryPath: absolutePath,
        defaultBranch: z.string().max(300).nullable(),
      })
      .strict(),
  },

  /** Clone/ensure a primary repo and seed `.bb/` on it when it does not carry one. */
  preparePrimaryProjectSource: {
    input: z
      .object({
        url: z.string().min(1).max(2000),
        path: absolutePath,
        seed: z.string().max(200_000),
        branch: z.string().min(1).max(300),
        openPullRequest: z.boolean(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        layout: projectLayoutSchema,
        seeded: z.boolean(),
        prUrl: z.string().max(600).nullable(),
        warnings: z.array(z.string().max(600)).max(20),
        message: z.string().max(2000),
      })
      .strict(),
  },
});

export type HostContract = typeof hostContract;

/** Progress from a long host call, relayed into the launch report. */
export const hostSignals = {
  progress: {
    payload: z
      .object({
        operationId: z.string().min(1).max(200),
        kind: z.enum(["step", "log"]),
        text: z.string().min(1).max(2000),
      })
      .strict(),
  },
} satisfies ExperimentalHostSignals;

/* --------------------------------------------------------------- frontend */

export const repoEntryViewSchema = z
  .object({
    dir: z.string().max(100),
    url: z.string().max(2000),
    branch: z.string().max(300).nullable(),
  })
  .strict();

export const repoSetViewSchema = z
  .object({
    /** Null when this project has no `.bb` checkout on a reachable machine. */
    projectSourcePath: absolutePath.nullable(),
    hostId: z.string().max(100).nullable(),
    /** `standalone` (definition at the root) or `primary` (`.bb/`). */
    layout: projectLayoutSchema,
    /** The primary repo derived from the source's `origin`, or null. */
    primary: z.object({ dir: z.string().max(100), url: z.string().max(2000) }).strict().nullable(),
    /** The file's raw text, for the editor. Null when it does not exist yet. */
    reposJson: z.string().max(200_000).nullable(),
    /** Parsed entries, empty when `error` is set. */
    repos: z.array(repoEntryViewSchema).max(64),
    /** The parse or validation failure, verbatim. */
    error: z.string().max(2000).nullable(),
    cache: z.array(cacheEntrySchema).max(200),
  })
  .strict();

export type RepoSetView = z.infer<typeof repoSetViewSchema>;

/** Another thread working in the same checkout, as the panel names it. */
export const sharingThreadSchema = z
  .object({
    threadId: z.string().min(1).max(100),
    /** Null when the thread could not be read, or has no title yet. */
    title: z.string().max(300).nullable(),
  })
  .strict();

export const workspaceViewSchema = z
  .object({
    root: absolutePath,
    branchName: z.string().max(300),
    hostId: z.string().max(100),
    projectSourcePath: absolutePath,
    /**
     * True when this workspace was provisioned from a standalone `.bb` and the
     * project source has since been adopted into a primary repo. Guidance
     * published from it still goes to the old canonical checkout, so it has to
     * be re-applied to the primary by hand.
     */
    predatesAdopt: z.boolean(),
    repos: z.array(workspaceRepoSchema).max(64),
    /**
     * The other threads attached to this same checkout — forks, which keep
     * the environment they were forked from. Empty for the common case of one
     * thread per workspace.
     */
    sharedWith: z.array(sharingThreadSchema).max(16),
  })
  .strict();

export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

/** The outcome of one structured edit to `repos.json`. */
export const editResultSchema = z
  .object({ ok: z.boolean(), error: z.string().max(2000).nullable() })
  .strict();

export const rpcContract = defineRpcContract({
  /**
   * Every project, for the Repos panel's own picker.
   *
   * A nav panel owns a top-level route with no project in it, so the page
   * cannot read one from the route the way a thread surface can — it has to
   * offer the choice itself.
   */
  projects: {
    input: z.null(),
    output: z
      .object({
        projects: z
          .array(
            z
              .object({
                id: z.string().max(100),
                name: z.string().max(300),
                /** False when the project has no checkout on any machine. */
                hasSource: z.boolean(),
              })
              .strict(),
          )
          .max(500),
      })
      .strict(),
  },
  /** The repo set for a project, plus per-repo object-cache state. */
  repoSet: {
    input: z.object({ projectId: z.string().min(1).max(100) }).strict(),
    output: repoSetViewSchema,
  },
  /**
   * Fast-forward the canonical `.bb` checkout to a thread's published guidance
   * branch. Stewards calls it, and only stewards: a lesson is the one thing
   * that writes itself into the guidance every steward reads, and the project
   * steward's own tooling is the only thing that may ask for it. `file` and
   * `text` are the lesson's own; the host refuses a merge that would change
   * anything else.
   */
  mergeGuidance: {
    input: z
      .object({
        projectId: z.string().min(1).max(100),
        threadId: z.string().min(1).max(100),
        file: projectFilePathSchema,
        text: z.string().min(1).max(20_000),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        sha: z.string().max(64).nullable(),
        branch: z.string().max(300).nullable(),
        message: z.string().max(2000),
      })
      .strict(),
  },

  /**
   * Files from the project's `.bb` repo, read from the canonical checkout's
   * committed `HEAD` after a fast-forward-only refresh.
   *
   * The cross-plugin half of this contract, with `repoSet`: stewards reads its
   * playbooks and settings through it. `head` is the commit read; a file the
   * commit does not have comes back with `content: null`.
   */
  readProjectFiles: {
    input: z
      .object({
        projectId: z.string().min(1).max(100),
        paths: z.array(projectFilePathSchema).min(1).max(PROJECT_FILES_MAX),
      })
      .strict(),
    output: z
      .object({
        /** Null when this project has no `.bb` checkout on a reachable machine. */
        projectSourcePath: absolutePath.nullable(),
        head: z.string().max(64).nullable(),
        files: z.array(projectFileSchema).max(PROJECT_FILES_MAX),
        error: z.string().max(2000).nullable(),
      })
      .strict(),
  },
  saveRepoSet: {
    input: z
      .object({ projectId: z.string().min(1).max(100), reposJson: z.string().max(200_000) })
      .strict(),
    output: z.object({ ok: z.boolean(), error: z.string().max(2000).nullable() }).strict(),
  },

  /*
   * Structured edits. Each one is a single commit with a message naming the
   * change, which is what the CLI and the agent tools already produce and what
   * `saveRepoSet` — a whole-file replacement — never could.
   */
  addRepo: {
    input: z.object({ projectId: z.string().min(1).max(100), repo: repoSeedSchema }).strict(),
    output: editResultSchema,
  },
  removeRepo: {
    input: z.object({ projectId: z.string().min(1).max(100), dir: z.string().min(1).max(100) }).strict(),
    output: editResultSchema,
  },
  setRepoBranch: {
    input: z
      .object({
        projectId: z.string().min(1).max(100),
        dir: z.string().min(1).max(100),
        /** Null returns the repo to its default branch. */
        branch: z.string().max(300).nullable(),
      })
      .strict(),
    output: editResultSchema,
  },

  /**
   * Local checkouts on the project's machine, for the add form's autocomplete.
   * The same discovery that seeds the object cache and proposes a repo set for
   * an empty project; here it is a person choosing rather than the plugin.
   */
  suggestRepos: {
    /**
     * Keyed by machine and `.bb` path rather than project, because the form
     * for a project that does not exist yet has no id to offer — only the
     * machine it chose and the path it was suggested.
     */
    input: z.object({ hostId: z.string().min(1).max(100), path: absolutePath }).strict(),
    output: z.object({ checkouts: z.array(discoveredCheckoutSchema).max(500) }).strict(),
  },

  /** Machines a new project's `.bb` checkout could live on. */
  hosts: {
    input: z.null(),
    output: z
      .object({
        hosts: z
          .array(
            z
              .object({
                id: z.string().max(100),
                name: z.string().max(300),
                connected: z.boolean(),
                /** The server's own machine, which is the sensible default. */
                primary: z.boolean(),
              })
              .strict(),
          )
          .max(200),
      })
      .strict(),
  },

  /** A default `.bb` location for a project that does not exist yet. */
  suggestProjectSource: {
    input: z.object({ hostId: z.string().min(1).max(100), name: z.string().min(1).max(300) }).strict(),
    output: z.object({ path: absolutePath, exists: z.boolean() }).strict(),
  },

  /**
   * Create a project whose source is a `.bb` checkout, in one step.
   *
   * Either initializes a fresh checkout seeded with `repos`, or clones an
   * existing `.bb` repo. The git work runs first so a failure there leaves no
   * dangling project; a failure after it leaves an initialized directory,
   * which the next attempt adopts rather than re-creates.
   */
  createProject: {
    input: z
      .object({
        name: z.string().min(1).max(300),
        hostId: z.string().min(1).max(100),
        path: absolutePath,
        source: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("fresh"), repos: z.array(repoSeedSchema).max(64) }).strict(),
          z.object({ kind: z.literal("clone"), url: z.string().min(1).max(2000) }).strict(),
          z
            .object({
              kind: z.literal("primary"),
              url: z.string().min(1).max(2000),
              /** The other repos to seed `.bb/repos.json` with. */
              repos: z.array(repoSeedSchema).max(64),
              /** Publish a seed branch and open a pull request. */
              openPullRequest: z.boolean().optional(),
            })
            .strict(),
        ]),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        projectId: z.string().max(100).nullable(),
        error: z.string().max(2000).nullable(),
        warnings: z.array(z.string().max(600)).max(20),
        /** The layout the source ended up with, when the project was created. */
        layout: projectLayoutSchema.nullable(),
        /** The seed/adopt pull request, when one was opened. */
        prUrl: z.string().max(600).nullable(),
      })
      .strict(),
  },

  /**
   * Adopt a standalone `.bb` into a primary repo, per machine.
   *
   * The first run copies the tree to `.bb/` on a branch and opens a pull
   * request; a later run, once `.bb/` is on the default branch, re-points the
   * project source at the primary checkout. Case A of BB-106: the project id,
   * every binding and every thread stay as they are.
   */
  adoptProjectSource: {
    input: z
      .object({
        projectId: z.string().min(1).max(100),
        /** URL or local path of the primary repo. */
        primary: z.string().min(1).max(2000),
        /** Where the primary clone lives or should be cloned to. */
        path: absolutePath,
        /** Publish a branch and open a pull request. */
        openPullRequest: z.boolean().optional(),
      })
      .strict(),
    output: z
      .object({
        status: z.enum(["already", "pull-request", "failed"]),
        message: z.string().max(2000),
        prUrl: z.string().max(600).nullable(),
        warnings: z.array(z.string().max(600)).max(20),
        primaryPath: absolutePath,
        defaultBranch: z.string().max(300).nullable(),
        /** True when the project source now points at the primary checkout. */
        repointed: z.boolean(),
      })
      .strict(),
  },

  /** The thread's workspace manifest, or null when the thread has none. */
  workspace: {
    input: z.object({ threadId: z.string().min(1).max(100) }).strict(),
    output: z.object({ workspace: workspaceViewSchema.nullable() }).strict(),
  },
  workspaceStatus: {
    input: z.object({ threadId: z.string().min(1).max(100) }).strict(),
    output: z.object({ repos: z.array(repoLiveStatusSchema).max(64) }).strict(),
  },
  changes: {
    input: z.object({ threadId: z.string().min(1).max(100) }).strict(),
    output: z.object({ repos: z.array(repoChangesSchema).max(64) }).strict(),
  },
  filePatch: {
    input: z
      .object({
        threadId: z.string().min(1).max(100),
        dir: z.string().min(1).max(100),
        file: z.string().min(1).max(4096),
        untracked: z.boolean(),
      })
      .strict(),
    output: z
      .object({
        patch: z.string().max(8 * 1024 * 1024),
        truncated: z.boolean(),
        error: z.string().max(600).nullable(),
      })
      .strict(),
  },
  pullRequests: {
    input: z.object({ threadId: z.string().min(1).max(100), refresh: z.boolean() }).strict(),
    output: z
      .object({
        repos: z.array(repoPullRequestSchema).max(64),
        fetchedAt: z.number().int().nullable(),
      })
      .strict(),
  },
  pullRequestAction: {
    input: z
      .object({
        threadId: z.string().min(1).max(100),
        dir: z.string().min(1).max(100),
        action: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("create"),
              title: z.string().min(1).max(300),
              body: z.string().max(60_000),
              draft: z.boolean(),
            })
            .strict(),
          z.object({ kind: z.literal("ready") }).strict(),
          z.object({ kind: z.literal("merge"), method: z.enum(["merge", "squash", "rebase"]) }).strict(),
          z.object({ kind: z.literal("push") }).strict(),
        ]),
      })
      .strict(),
    output: z
      .object({ ok: z.boolean(), message: z.string().max(2000), url: z.string().max(600).nullable() })
      .strict(),
  },
});

export type RpcContract = typeof rpcContract;
