/**
 * The server entry: the environment provider, the agent surface, the CLI, and
 * the frontend's data plane.
 *
 * Three entry points in one package (server, host, app) because `bb.storage`
 * and RPC routes are namespaced per plugin: the panel needs the manifests the
 * provider writes, and splitting provisioning from UI would mean one plugin
 * reaching into another's state, which bb does not offer and should not.
 *
 * Nothing here touches a filesystem. Every path operation goes to `host.ts` on
 * the machine that holds the repos — a plugin's `run` and RPC handlers execute
 * on the *server*, which on a multi-machine install is a different computer
 * from the one the workspace lives on.
 */
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import type { PluginEnvironmentProviderProgress } from "@get-bb/plugin-sdk/environment-provider";
import { z } from "zod";
import {
  hostContract,
  hostSignals,
  rpcContract,
  type CacheEntry,
  type RepoPullRequest,
  type RepoRequest,
  type RepoSeed,
  type RepoTarget,
} from "./contract.js";
import {
  describeRepo,
  formatInstructions,
  readyRepos,
  withSharedNotice,
  type WorkspaceManifest,
  type WorkspaceRepo,
} from "./layout.js";
import {
  EMPTY_REPOS,
  MAX_REPOS,
  REPOS_FILE,
  addRepo,
  dirFromUrl,
  findRepo,
  parseReposFile,
  removeRepo,
  resolveRepoEntry,
  serializeReposFile,
  setRepoBranch,
  validateRepoSet,
  type RepoEntry,
  type ReposFile,
} from "./repos.js";
import { PROJECT_SOURCE_DIR, normalizeRemoteUrl } from "./paths.js";
import {
  CACHE_BACKGROUND_MS,
  CACHE_FRESH_MS,
  ENVIRONMENT_PROVIDER_ID,
  MAX_DIFF_FILES,
  MAX_PATCH_BYTES,
  PR_CACHE_TTL_MS,
  REPOS_CHANGED_CHANNEL,
  THREAD_CHANGES_CHANNEL,
} from "./shared.js";

const CREATE_TIMEOUT_MS = 60 * 60 * 1000;
const REMOVE_TIMEOUT_MS = 10 * 60 * 1000;
const READ_TIMEOUT_MS = 90_000;
const ACTION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * What this plugin needs off `threads.get({ include: "environment" })`.
 * Structural on purpose — the SDK's shape is much wider and none of the rest
 * of it is any of this plugin's business.
 */
interface ThreadEnvironment {
  id: string;
  hostId: string;
  environmentProviderId: string | null;
  environmentProviderInstanceKey: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function multiRepoPlugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    searchRoot: {
      type: "string",
      label: "Extra search root",
      default: "",
      experimental_schema: z
        .string()
        .max(4096)
        .refine((value) => value === "" || value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value), {
          message: "Must be an absolute path, or empty.",
        }),
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS workspaces (
       host_id TEXT NOT NULL,
       path_key TEXT NOT NULL,
       thread_id TEXT NOT NULL,
       project_id TEXT NOT NULL,
       root TEXT NOT NULL,
       branch_name TEXT NOT NULL,
       project_source_path TEXT NOT NULL,
       repos TEXT NOT NULL,
       instructions TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       PRIMARY KEY (host_id, path_key)
     )`,
    `CREATE INDEX IF NOT EXISTS workspaces_thread ON workspaces (thread_id)`,
    `CREATE TABLE IF NOT EXISTS pr_cache (
       thread_id TEXT NOT NULL,
       dir TEXT NOT NULL,
       payload TEXT NOT NULL,
       fetched_at INTEGER NOT NULL,
       PRIMARY KEY (thread_id, dir)
     )`,
    // Threads are many-to-one with workspaces, because environments are
    // many-to-one with threads: a fork reuses its source thread's environment,
    // so `create()` never runs for it and no second workspace exists. Resolving
    // by `workspaces.thread_id` made every thread-scoped surface go blank for a
    // fork. This table is what a thread now resolves through, and the backfill
    // keeps every workspace written before it bound to its creating thread.
    //
    // It holds no fact core does not already own — core knows which environment
    // a thread runs on. It exists because `contributeInstructions` is
    // synchronous and asking core is not, so the answer has to be on hand
    // locally before a thread's first turn.
    `CREATE TABLE IF NOT EXISTS workspace_threads (
       thread_id TEXT PRIMARY KEY,
       host_id TEXT NOT NULL,
       path_key TEXT NOT NULL,
       bound_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS workspace_threads_workspace ON workspace_threads (host_id, path_key)`,
    `INSERT OR IGNORE INTO workspace_threads (thread_id, host_id, path_key, bound_at)
       SELECT thread_id, host_id, path_key, created_at FROM workspaces`,
  ]);

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  /**
   * Live launch reports, keyed by the operation id the host echoes back.
   *
   * The host worker cannot reach `context.report` directly, so a long call
   * emits `progress` signals and this map routes each one to the launch that
   * is waiting on it.
   */
  const reports = new Map<string, PluginEnvironmentProviderProgress>();
  host.experimental_onSignal("progress", (event) => {
    const report = reports.get(event.payload.operationId);
    if (report === undefined) return;
    if (event.payload.kind === "step") report.step(event.payload.text);
    else report.log(event.payload.text);
  });

  /* ------------------------------------------------------------ storage */

  function saveManifest(manifest: WorkspaceManifest): void {
    db.prepare(
      `INSERT INTO workspaces
         (host_id, path_key, thread_id, project_id, root, branch_name, project_source_path, repos, instructions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (host_id, path_key) DO UPDATE SET
         thread_id = excluded.thread_id,
         project_id = excluded.project_id,
         root = excluded.root,
         branch_name = excluded.branch_name,
         project_source_path = excluded.project_source_path,
         repos = excluded.repos,
         instructions = excluded.instructions,
         created_at = excluded.created_at`,
    ).run(
      manifest.hostId,
      manifest.pathKey,
      manifest.threadId,
      manifest.projectId,
      manifest.root,
      manifest.branchName,
      manifest.projectSourcePath,
      JSON.stringify(manifest.repos),
      formatInstructions(manifest),
      manifest.createdAt,
    );
  }

  function rowToManifest(row: Record<string, unknown>): WorkspaceManifest | null {
    try {
      return {
        hostId: String(row.host_id),
        pathKey: String(row.path_key),
        threadId: String(row.thread_id),
        projectId: String(row.project_id),
        root: String(row.root),
        branchName: String(row.branch_name),
        projectSourcePath: String(row.project_source_path),
        repos: JSON.parse(String(row.repos)) as WorkspaceRepo[],
        createdAt: Number(row.created_at),
      };
    } catch {
      return null;
    }
  }

  /** Where a workspace lives: the one key every read and binding is written against. */
  interface WorkspaceKey {
    hostId: string;
    pathKey: string;
  }

  /**
   * Attach a thread to a workspace.
   *
   * Many-to-one deliberately. The alternative — one workspace per thread — is
   * what core already declined to do for forks, and a plugin cannot provision
   * a second checkout for an environment core considers provisioned.
   */
  function bindThread(threadId: string, key: WorkspaceKey): void {
    db.prepare(
      `INSERT INTO workspace_threads (thread_id, host_id, path_key, bound_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (thread_id) DO UPDATE SET
         host_id = excluded.host_id,
         path_key = excluded.path_key,
         bound_at = excluded.bound_at`,
    ).run(threadId, key.hostId, key.pathKey, Date.now());
    unresolved.delete(threadId);
  }

  /** Synchronous on purpose — `contributeInstructions` cannot await. */
  function manifestForThread(threadId: string): WorkspaceManifest | null {
    const row = db
      .prepare(
        `SELECT w.* FROM workspace_threads b
           JOIN workspaces w ON w.host_id = b.host_id AND w.path_key = b.path_key
          WHERE b.thread_id = ?`,
      )
      .get(threadId) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToManifest(row);
  }

  function manifestForKey(key: WorkspaceKey): WorkspaceManifest | null {
    const row = db
      .prepare(`SELECT * FROM workspaces WHERE host_id = ? AND path_key = ?`)
      .get(key.hostId, key.pathKey) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToManifest(row);
  }

  /** The other threads working in one workspace, oldest binding first. */
  function sharingThreads(key: WorkspaceKey, exceptThreadId: string): string[] {
    const rows = db
      .prepare(
        `SELECT thread_id FROM workspace_threads
          WHERE host_id = ? AND path_key = ? AND thread_id <> ?
          ORDER BY bound_at ASC LIMIT 16`,
      )
      .all(key.hostId, key.pathKey, exceptThreadId) as { thread_id: string }[];
    return rows.map((row) => row.thread_id);
  }

  /**
   * Threads a lookup has already failed for, and when.
   *
   * The file opener calls `workspace` for every file bb opens anywhere, so the
   * miss path is the hot one and it is the path that costs an SDK round trip.
   * Short-lived on purpose: a thread whose `create()` is still running is a
   * miss that becomes a hit, and `bindThread` clears the entry the moment it
   * does.
   */
  const unresolved = new Map<string, number>();
  const UNRESOLVED_TTL_MS = 60_000;

  /** In-flight `bindInheritedWorkspace` walks, one per thread. */
  const resolving = new Map<string, Promise<WorkspaceManifest | null>>();

  /**
   * The workspace a thread is working in, binding it first when it has
   * inherited one it was never bound to.
   *
   * Every asynchronous path goes through this rather than `manifestForThread`:
   * a fork's first surface — a panel, a tool call, `bb repos status` — is
   * usually what discovers the binding, and discovering it means persisting it
   * so the synchronous instruction path can read it on the next turn.
   */
  async function resolveManifest(threadId: string): Promise<WorkspaceManifest | null> {
    const bound = manifestForThread(threadId);
    if (bound !== null) return bound;
    const failedAt = unresolved.get(threadId);
    if (failedAt !== undefined && Date.now() - failedAt < UNRESOLVED_TTL_MS) return null;
    // One walk per thread at a time: a panel load asks four of these questions
    // at once, and they would otherwise be four identical SDK walks racing to
    // write the same binding.
    const running = resolving.get(threadId);
    if (running !== undefined) return running;
    const walk = bindInheritedWorkspace(threadId)
      .then((manifest) => {
        if (manifest === null) unresolved.set(threadId, Date.now());
        return manifest;
      })
      .finally(() => resolving.delete(threadId));
    resolving.set(threadId, walk);
    return walk;
  }

  /**
   * Bind a thread to the workspace its environment already has.
   *
   * No lineage is involved, deliberately. Core tells us which environment the
   * thread runs on and which instance key that environment was provisioned
   * under — and that key *is* this table's `path_key`, so the answer is one
   * primary-key read. Walking `sourceThreadId` back through a fork chain would
   * reach the same row the long way round, and would get a fork that was given
   * its own environment wrong.
   */
  async function bindInheritedWorkspace(threadId: string): Promise<WorkspaceManifest | null> {
    let environment: ThreadEnvironment | null;
    try {
      const thread = await bb.sdk.threads.get({ threadId, include: "environment" });
      environment = "environment" in thread ? thread.environment ?? null : null;
    } catch (error) {
      bb.log.debug(`Could not read thread ${threadId}: ${errorMessage(error)}`);
      return null;
    }
    // No environment yet, or someone else's: nothing of ours to attach to.
    if (environment === null || environment.environmentProviderId !== ENVIRONMENT_PROVIDER_ID) return null;
    // Mirrors how core derives the `pathKey` it hands `create()`.
    const key = {
      hostId: environment.hostId,
      pathKey: environment.environmentProviderInstanceKey ?? environment.id,
    };
    const manifest = manifestForKey(key);
    if (manifest === null) return null;
    bindThread(threadId, key);
    return manifest;
  }

  /**
   * The generated block, as this thread should read it.
   *
   * Stored text plus one thing `create()` could not know: whether someone else
   * is in the same directory by now.
   */
  function instructionsForThread(threadId: string): string | null {
    const row = db
      .prepare(
        `SELECT w.instructions, w.host_id, w.path_key, w.branch_name FROM workspace_threads b
           JOIN workspaces w ON w.host_id = b.host_id AND w.path_key = b.path_key
          WHERE b.thread_id = ?`,
      )
      .get(threadId) as
      | { instructions?: unknown; host_id: string; path_key: string; branch_name: string }
      | undefined;
    const text = row?.instructions;
    if (row === undefined || typeof text !== "string" || text.length === 0) return null;
    const others = sharingThreads({ hostId: row.host_id, pathKey: row.path_key }, threadId);
    return withSharedNotice(text, { others: others.length, branchName: row.branch_name });
  }

  function forgetWorkspace(hostId: string, pathKey: string): void {
    const rows = db
      .prepare(`SELECT thread_id FROM workspace_threads WHERE host_id = ? AND path_key = ?`)
      .all(hostId, pathKey) as { thread_id: string }[];
    db.prepare(`DELETE FROM workspace_threads WHERE host_id = ? AND path_key = ?`).run(hostId, pathKey);
    db.prepare(`DELETE FROM workspaces WHERE host_id = ? AND path_key = ?`).run(hostId, pathKey);
    for (const row of rows) {
      db.prepare(`DELETE FROM pr_cache WHERE thread_id = ?`).run(row.thread_id);
      // A thread whose workspace just went away may still inherit another
      // one — let it ask again rather than serving it a cached miss.
      unresolved.delete(row.thread_id);
    }
  }

  function changed(): void {
    bb.realtime.publish(REPOS_CHANGED_CHANNEL, { at: Date.now() });
  }

  /**
   * One thread's working tree may have moved.
   *
   * `pullRequests` says whether the `gh`-backed half moved too, so a routine
   * turn-finished signal does not make every open panel shell out to `gh`.
   */
  function threadChanged(threadId: string, options: { pullRequests: boolean } = { pullRequests: false }): void {
    bb.realtime.publish(THREAD_CHANGES_CHANNEL, {
      at: Date.now(),
      threadId,
      pullRequests: options.pullRequests,
    });
  }

  /**
   * A finished turn is the moment the diff is worth looking at again.
   *
   * Nothing in bb tells a panel that files on a machine changed, and every
   * other publisher on these channels fires on environment or repo-set edits
   * only — which is why an open Changes tab used to keep showing whatever was
   * on disk when it mounted. The panel also polls while it is open; this is
   * what makes a finished turn land without waiting for the next tick.
   */
  bb.events.on("thread.idle", ({ thread }) => {
    if (manifestForThread(thread.id) === null) return;
    threadChanged(thread.id);
  });

  /* ------------------------------------------------- the project source */

  interface SourceLocation {
    hostId: string;
    path: string;
  }

  /**
   * Where this project's `.bb` checkout lives, and on which machine.
   *
   * A project can have a source on several machines — core keeps one per
   * `(project, host)`. The server's own machine is preferred because that is
   * where an RPC or CLI call can reach a host worker with the least surprise;
   * anything else is a reasonable fallback rather than a guess.
   */
  async function projectSource(projectId: string): Promise<SourceLocation | null> {
    const project = await bb.sdk.projects.get({ projectId });
    const sources = project.sources.filter((source) => source.type === "local_path");
    if (sources.length === 0) return null;
    const primary = (await bb.sdk.system.config()).primaryHostId;
    const preferred =
      sources.find((source) => source.hostId === primary) ??
      sources.find((source) => source.isDefault) ??
      sources[0];
    return { hostId: preferred.hostId, path: preferred.path };
  }

  /**
   * Read the repo set.
   *
   * `bootstrap` is true only where an absent `.git` genuinely should be
   * created — provisioning, and the commands that are about to commit to it.
   * A panel refresh or `bb repos list` must not `git init` a directory as a
   * side effect of looking at it.
   */
  async function readRepoSet(
    location: SourceLocation,
    options: { bootstrap: boolean },
    signal?: AbortSignal,
  ): Promise<{ text: string | null; file: ReposFile | null; error: string | null }> {
    const prepared = await host.call(
      "prepareProjectSource",
      { path: location.path, fetchTtlMs: CACHE_FRESH_MS, bootstrap: options.bootstrap },
      { hostId: location.hostId, timeoutMs: READ_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
    );
    if (prepared.reposJson === null) return { text: null, file: EMPTY_REPOS, error: null };
    const parsed = parseReposFile(prepared.reposJson);
    return parsed.ok
      ? { text: prepared.reposJson, file: parsed.value, error: null }
      : { text: prepared.reposJson, file: null, error: parsed.error };
  }

  async function writeRepoSet(
    location: SourceLocation,
    file: ReposFile,
    message: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await host.call(
      "writeProjectSourceRepos",
      { path: location.path, reposJson: serializeReposFile(file), message },
      { hostId: location.hostId, timeoutMs: READ_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
    );
    // The file is written either way, but an uncommitted change is not shared
    // with anyone else and will confuse the next person to pull. Say so rather
    // than reporting success.
    if (!result.committed && result.message !== null) {
      throw new Error(`${REPOS_FILE} was written but not committed: ${result.message}`);
    }
    changed();
  }

  /**
   * The three structured edits, shared by the CLI, the agent tools and the
   * panel so each surface commits the same one-line diff with the same
   * message. A failure carries a code the CLI can surface and a sentence the
   * other two can show as it is.
   */
  type EditOutcome = { ok: true; dir: string } | { ok: false; code: string; error: string };

  async function addRepoToProject(
    location: SourceLocation,
    seed: RepoSeed,
    signal?: AbortSignal,
  ): Promise<EditOutcome> {
    const current = await readRepoSet(location, { bootstrap: true }, signal);
    if (current.file === null) {
      return { ok: false, code: "invalid_repos_json", error: current.error ?? `${REPOS_FILE} could not be read.` };
    }
    const entry = resolveRepoEntry(seed);
    if (entry === null) {
      return {
        ok: false,
        code: "dir_required",
        error: `Could not derive a directory name from ${seed.url}. Give the repo an explicit directory name.`,
      };
    }
    const clash = findRepo(current.file, { dir: entry.dir, url: seed.url });
    if (clash !== null) {
      return { ok: false, code: "duplicate_repo", error: `${clash.dir} is already in the repo set (${clash.url}).` };
    }
    const edited = addRepo(current.file, entry);
    if (!edited.ok) return { ok: false, code: "invalid_repo_set", error: edited.error };
    await writeRepoSet(location, edited.value, `Add ${entry.dir} to the repo set`, signal);
    return { ok: true, dir: entry.dir };
  }

  async function removeRepoFromProject(
    location: SourceLocation,
    dir: string,
    signal?: AbortSignal,
  ): Promise<EditOutcome> {
    const current = await readRepoSet(location, { bootstrap: false }, signal);
    if (current.file === null) {
      return { ok: false, code: "invalid_repos_json", error: current.error ?? `${REPOS_FILE} could not be read.` };
    }
    const edited = removeRepo(current.file, dir);
    if (!edited.ok) return { ok: false, code: "unknown_repo", error: edited.error };
    await writeRepoSet(location, edited.value, `Remove ${dir} from the repo set`, signal);
    return { ok: true, dir };
  }

  async function setProjectRepoBranch(
    location: SourceLocation,
    dir: string,
    branch: string | null,
    signal?: AbortSignal,
  ): Promise<EditOutcome> {
    const current = await readRepoSet(location, { bootstrap: false }, signal);
    if (current.file === null) {
      return { ok: false, code: "invalid_repos_json", error: current.error ?? `${REPOS_FILE} could not be read.` };
    }
    const edited = setRepoBranch(current.file, dir, branch);
    if (!edited.ok) return { ok: false, code: "unknown_repo", error: edited.error };
    const next = edited.value.repos.find((repo) => repo.dir === dir)?.branch;
    const message = next === undefined ? `Use the default branch for ${dir}` : `Base ${dir} on ${next}`;
    await writeRepoSet(location, edited.value, message, signal);
    return { ok: true, dir };
  }

  /**
   * Resolve and validate a repo set a person assembled in the panel before a
   * project existed to commit it to. Returns the first problem as the panel
   * should show it, or the entries ready to seed a fresh `repos.json`.
   */
  function resolveSeed(seed: readonly RepoSeed[]): { ok: true; repos: RepoEntry[] } | { ok: false; error: string } {
    if (seed.length > MAX_REPOS) return { ok: false, error: `A workspace may hold at most ${MAX_REPOS} repos.` };
    const repos: RepoEntry[] = [];
    for (const entry of seed) {
      const resolved = resolveRepoEntry(entry);
      if (resolved === null) {
        return { ok: false, error: `Could not derive a directory name from ${entry.url}. Give it an explicit directory name.` };
      }
      repos.push(resolved);
    }
    const problem = validateRepoSet(repos);
    return problem === null ? { ok: true, repos } : { ok: false, error: problem };
  }

  /**
   * Every git checkout bb knows about on one machine.
   *
   * Feeds two things: the object cache's local-mirror step, and the repo-set
   * proposal for a project that has none. Failure is never fatal — the worst
   * case is a cold network clone, which is what would have happened anyway.
   */
  async function localCheckouts(
    hostId: string,
    projectSourcePath: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; url: string }[]> {
    try {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      const paths = new Set<string>();
      for (const project of projects) {
        for (const source of project.sources) {
          if (source.type === "local_path" && source.hostId === hostId) paths.add(source.path);
        }
      }
      paths.delete(projectSourcePath);
      const configured = (await settings.get()).searchRoot;
      const searchRoots = [parentOf(projectSourcePath), ...(configured.length > 0 ? [configured] : [])];
      const result = await host.call(
        "discoverCheckouts",
        { paths: [...paths].slice(0, 500), searchRoots },
        { hostId, timeoutMs: READ_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
      );
      return result.checkouts;
    } catch (error) {
      bb.log.warn(`Could not enumerate local checkouts on ${hostId}: ${errorMessage(error)}`);
      return [];
    }
  }

  function parentOf(target: string): string {
    const normalized = target.replace(/[\\/]+$/u, "");
    const cut = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    return cut <= 0 ? normalized : normalized.slice(0, cut);
  }

  /* ---------------------------------------------- the environment provider */

  bb.experimental_environments.register({
    id: ENVIRONMENT_PROVIDER_ID,
    displayName: "Multi-repo workspace",
    description: "One directory per thread, holding a checkout of every repo in the project.",
    icon: "FolderGit",
    // `projectCheckout` guarantees a non-null `context.projectCheckout.path`
    // with no git availability gating — that only fires for `gitCheckout`,
    // and the project source here may legitimately not be a repo yet.
    requires: { projectCheckout: true },
    // Both defaults, taken deliberately. `per-thread` path keys mean a rebuild
    // re-clones every repo, which is the right trade against serving a
    // half-torn-down workspace — and the object cache keeps that cost local.
    // The five-minute retire grace is right too: keeping these indefinitely
    // would accumulate a full checkout set per thread on the machine's disk.
    policy: { pathKeys: "per-thread", retireGraceMs: 5 * 60 * 1000 },

    async create(context) {
      const hostId = context.host.id;
      const operationId = `create#${context.pathKey}#${context.attempt}`;
      reports.set(operationId, context.report);
      try {
        context.report.step("Reading the project definition");
        const location: SourceLocation = { hostId, path: context.projectCheckout.path };
        const prepared = await host.call(
          "prepareProjectSource",
          { path: location.path, fetchTtlMs: CACHE_FRESH_MS, bootstrap: true },
          { hostId, signal: context.signal, timeoutMs: READ_TIMEOUT_MS },
        );
        for (const warning of prepared.warnings) context.report.log(warning);
        if (prepared.bootstrapped) {
          context.report.log(`Initialized a new project definition in ${location.path}`);
        }

        let repoSet: ReposFile;
        if (prepared.reposJson === null) {
          repoSet = EMPTY_REPOS;
        } else {
          const parsed = parseReposFile(prepared.reposJson);
          if (!parsed.ok) {
            // `repos.json` is on the critical path for every thread in the
            // project, so the failure names the offending entry rather than
            // producing a mysteriously empty workspace.
            return { status: "failed", message: parsed.error };
          }
          repoSet = parsed.value;
        }

        context.report.step("Looking for repos already on this machine");
        const mirrors = await localCheckouts(hostId, location.path, context.signal);

        if (repoSet.repos.length === 0) {
          const seeded = proposeRepoSet(mirrors);
          if (seeded.repos.length === 0) {
            return {
              status: "failed",
              message: `No repos are configured. Add some to ${REPOS_FILE} in ${location.path}, or run \`bb repos add <url>\`.`,
            };
          }
          context.report.log(
            `Seeding an empty repo set with ${seeded.repos.length} repo(s) found on this machine: ${seeded.repos
              .map((repo) => repo.dir)
              .join(", ")}`,
          );
          await writeRepoSet(location, seeded, "Seed the repo set from checkouts on this machine", context.signal);
          repoSet = seeded;
        }

        // Claim before writing. Two environments must never share a root, and
        // the claim is what makes that core's answer rather than a race here.
        const root = await plannedRoot(hostId, context.pathKey);
        if (root !== null && !(await context.experimental_claimPath(root))) {
          return { status: "failed", message: `${root} is already in use by another environment.` };
        }

        context.report.step(`Preparing ${repoSet.repos.length} repo(s)`);
        const provisioned = await host.call(
          "provisionWorkspace",
          {
            operationId,
            pathKey: context.pathKey,
            projectSourcePath: location.path,
            repos: repoSet.repos.map(toRepoRequest),
            branchName: context.suggestedBranchName,
            fetchTtlMs: CACHE_FRESH_MS,
            mirrors,
          },
          { hostId, signal: context.signal, timeoutMs: CREATE_TIMEOUT_MS },
        );

        const manifest: WorkspaceManifest = {
          root: provisioned.root,
          pathKey: context.pathKey,
          hostId,
          threadId: context.thread.id,
          projectId: context.project.id,
          branchName: context.suggestedBranchName,
          projectSourcePath: location.path,
          repos: provisioned.repos,
          createdAt: Date.now(),
        };
        saveManifest(manifest);
        bindThread(context.thread.id, manifest);
        changed();

        const failed = provisioned.repos.filter((repo) => repo.status === "failed");
        for (const repo of failed) context.report.log(`${repo.dir}: ${repo.message ?? "failed to clone"}`);
        if (failed.length === provisioned.repos.length) {
          return {
            status: "failed",
            message: `No repo could be checked out. ${failed[0]?.message ?? ""}`.trim(),
          };
        }
        context.report.step(`Ready — ${provisioned.repos.length - failed.length} repo(s) checked out`);

        return {
          status: "created",
          path: provisioned.root,
          ownsPath: true,
          // Deliberately no `mergeBaseBranch`: it is a single value on a
          // flattened environment row, and this workspace has one merge base
          // per repo. Publishing one repo's base as if it spoke for all of
          // them would be worse than publishing none — the diff layer
          // computes merge bases per repo instead.
          resource: {
            version: 1,
            root: provisioned.root,
            repos: provisioned.repos.map((repo) => ({
              dir: repo.dir,
              branch: repo.branch,
              status: repo.status,
            })),
          },
        };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: errorMessage(error) };
      } finally {
        reports.delete(operationId);
      }
    },

    async remove(context) {
      if (context.hostId === null) {
        return { status: "failed", message: "The workspace machine is unknown." };
      }
      const operationId = `remove#${context.pathKey}#${context.attempt}`;
      reports.set(operationId, context.report);
      try {
        await host.call(
          "removeWorkspace",
          { operationId, pathKey: context.pathKey, path: context.path },
          { hostId: context.hostId, signal: context.signal, timeoutMs: REMOVE_TIMEOUT_MS },
        );
        forgetWorkspace(context.hostId, context.pathKey);
        changed();
        return { status: "removed" };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: errorMessage(error) };
      } finally {
        reports.delete(operationId);
      }
    },
  });

  /**
   * The root `create()` will use, for the pre-write claim.
   *
   * Derived from a manifest this plugin already wrote for the same key when
   * there is one. On a first launch there is nothing to derive it from without
   * asking the host where its data directory is, and the claim is then made
   * against the root the host reports after provisioning — which is why a null
   * here is not an error.
   */
  async function plannedRoot(hostId: string, pathKey: string): Promise<string | null> {
    const row = db
      .prepare(`SELECT root FROM workspaces WHERE host_id = ? AND path_key = ?`)
      .get(hostId, pathKey) as { root?: unknown } | undefined;
    return typeof row?.root === "string" ? row.root : null;
  }

  function toRepoRequest(repo: { dir: string; url: string; branch?: string }): RepoRequest {
    return { dir: repo.dir, url: repo.url, branch: repo.branch ?? null };
  }

  /**
   * Turn discovered checkouts into a starting repo set.
   *
   * Only ever used when `repos.json` holds nothing: the alternative is handing
   * someone an empty directory and no explanation. Deduplicated by remote and
   * capped, because a machine with forty checkouts should not produce a forty
   * repo workspace by accident.
   */
  function proposeRepoSet(mirrors: readonly { path: string; url: string }[]): ReposFile {
    const seen = new Set<string>();
    const repos: ReposFile["repos"] = [];
    for (const mirror of mirrors) {
      if (repos.length >= 8) break;
      const key = normalizeRemoteUrl(mirror.url);
      if (seen.has(key)) continue;
      const dir = dirFromUrl(mirror.url);
      if (dir === null || dir === PROJECT_SOURCE_DIR) continue;
      if (repos.some((repo) => repo.dir === dir)) continue;
      seen.add(key);
      repos.push({ dir, url: mirror.url, inferredDir: true });
    }
    return { version: 1, repos };
  }

  /* --------------------------------------------------- the agent surface */

  /**
   * The generated facts block.
   *
   * Synchronous and on the thread-start path, so it does no work beyond one
   * indexed row read: `create()` already formatted the text. It is
   * authoritative at thread start and stale only with respect to
   * `workspace_add_repo` — a live provider session keeps the instructions it
   * was constructed with, never mid-session — which is precisely why that tool
   * returns the new repo's location in its own result text.
   */
  bb.agents.contributeInstructions(({ threadId }) => {
    if (threadId === null || threadId === undefined) return null;
    return instructionsForThread(threadId);
  });

  /**
   * Bind a fork to the workspace it inherited, before its first turn.
   *
   * The lazy bind in `resolveManifest` is the backstop for every asynchronous
   * path, but `contributeInstructions` is synchronous and can only read a
   * binding that is already persisted. This is the one place the binding can
   * be written early enough for a fork's first turn to carry the layout block,
   * which is why it runs on `thread.created` rather than on first use.
   */
  bb.events.on("thread.created", async ({ thread }) => {
    if (thread.environmentId === null || manifestForThread(thread.id) !== null) return;
    const manifest = await bindInheritedWorkspace(thread.id);
    if (manifest !== null) changed();
  });

  /**
   * Release a deleted thread's claim on a shared checkout, so the warning the
   * other thread reads counts only threads someone might actually be running.
   * An undeleted thread binds itself again on its next surface.
   */
  bb.events.on("thread.deleted", ({ thread }) => {
    const had = manifestForThread(thread.id);
    if (had === null) return;
    db.prepare(`DELETE FROM workspace_threads WHERE thread_id = ?`).run(thread.id);
    unresolved.delete(thread.id);
    changed();
  });

  /** The workspace a tool call is running inside, or a thrown explanation. */
  async function requireManifest(threadId: string | null | undefined): Promise<WorkspaceManifest> {
    const manifest =
      threadId === null || threadId === undefined ? null : await resolveManifest(threadId);
    if (manifest === null) {
      // Deliberately does not blame another provider. The overwhelmingly
      // common way to get here used to be a fork of a thread this very
      // provider built, and being told the opposite sent people looking in the
      // wrong place entirely.
      throw new Error(
        "This thread has no multi-repo workspace: no environment created by the Multi-repo workspace provider is attached to it.",
      );
    }
    return manifest;
  }

  bb.agents.registerTool({
    name: "workspace_list_repos",
    description:
      "List the repos in this thread's multi-repo workspace, with each one's directory, branch, and absolute path.",
    instructions:
      "Use workspace_list_repos when you need a repo's absolute path or branch and the workspace layout block is not enough.",
    presentation: { label: { pending: "Listing workspace repos", completed: "Listed workspace repos" } },
    parameters: z.object({}),
    async execute(_input, { threadId }) {
      const manifest = await requireManifest(threadId);
      const lines = manifest.repos.map(describeRepo);
      return [`dir\tbranch\tpath`, ...lines].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "workspace_add_repo",
    description:
      "Add a git repo to this project's repo set and clone it into the live workspace, without restarting the thread.",
    instructions:
      "workspace_add_repo edits the project's shared repos.json, so it affects every future thread in this project. Use it when work genuinely spans another repo, not to fetch something for a one-off look.",
    presentation: { label: { pending: "Adding a repo to the workspace", completed: "Added a repo to the workspace" } },
    parameters: z.object({
      url: z.string().min(1).max(2000).describe("Anything git can clone, including an absolute local path."),
      dir: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe("Directory name inside the workspace. Defaults to the repo's name."),
      branch: z.string().min(1).max(300).optional().describe("Base branch. Defaults to the repo's default branch."),
    }),
    async execute(input, { threadId, signal }) {
      const manifest = await requireManifest(threadId);
      const location: SourceLocation = { hostId: manifest.hostId, path: manifest.projectSourcePath };
      const seed: RepoSeed = {
        ...(input.dir === undefined ? {} : { dir: input.dir }),
        url: input.url,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
      };
      // All three writes run host-side: the commit in the canonical checkout,
      // the cache population, and the clone into the live workspace. That is
      // what makes this work while the agent is sandboxed.
      const outcome = await addRepoToProject(location, seed, signal);
      if (!outcome.ok) throw new Error(outcome.error);
      const dir = outcome.dir;
      const entry = resolveRepoEntry(seed);
      if (entry === null) throw new Error(`Could not derive a directory name from ${input.url}.`);

      const added = await host.call(
        "addWorkspaceRepo",
        {
          operationId: `add#${manifest.pathKey}#${dir}#${Date.now()}`,
          pathKey: manifest.pathKey,
          root: manifest.root,
          repo: toRepoRequest(entry),
          branchName: manifest.branchName,
          fetchTtlMs: CACHE_FRESH_MS,
          mirrors: await localCheckouts(manifest.hostId, manifest.projectSourcePath, signal),
        },
        { hostId: manifest.hostId, timeoutMs: CREATE_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
      );

      saveManifest({ ...manifest, repos: [...manifest.repos.filter((r) => r.dir !== dir), added.repo] });
      changed();

      if (added.repo.status === "failed") {
        throw new Error(
          `${dir} was added to ${REPOS_FILE} but could not be cloned: ${added.repo.message ?? "unknown error"}`,
        );
      }
      // The result text carries the facts rather than pointing at the layout
      // block: that block was built at thread start and this session will
      // never see a new version of it.
      return [
        `Added ${dir}.`,
        `path: ${added.repo.path}`,
        `branch: ${added.repo.branch} (based on ${added.repo.baseBranch})`,
        `remote: ${added.repo.remote}`,
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "workspace_remove_repo",
    description:
      "Remove a repo from this project's repo set. Existing workspaces keep their checkout; future threads will not get it.",
    presentation: { label: { pending: "Removing a repo from the repo set", completed: "Removed a repo from the repo set" } },
    parameters: z.object({ dir: z.string().min(1).max(100) }),
    async execute(input, { threadId, signal }) {
      const manifest = await requireManifest(threadId);
      const location: SourceLocation = { hostId: manifest.hostId, path: manifest.projectSourcePath };
      const outcome = await removeRepoFromProject(location, input.dir, signal);
      if (!outcome.ok) throw new Error(outcome.error);
      // Deliberately leaves the checkout alone. A workspace should not mutate
      // under a running thread, and deleting a directory the agent may have
      // uncommitted work in would be the worst possible way to learn that.
      return `Removed ${input.dir} from ${REPOS_FILE}. The existing checkout at ${manifest.root}/${input.dir} is untouched.`;
    },
  });

  bb.agents.registerTool({
    name: "workspace_publish_guidance",
    description:
      "Publish commits made in this workspace's .bb directory (AGENTS.md, skills, repos.json) back to the project's canonical checkout, as a branch to review and merge.",
    instructions:
      "Commit inside .bb first, then call workspace_publish_guidance. The canonical checkout is outside your sandbox, so a plain git push will not reach it.",
    presentation: { label: { pending: "Publishing workspace guidance", completed: "Published workspace guidance" } },
    parameters: z.object({}),
    async execute(_input, { threadId, signal }) {
      const manifest = await requireManifest(threadId);
      const source = manifest.repos.find((repo) => repo.dir === PROJECT_SOURCE_DIR);
      if (source === undefined || source.status !== "ready") {
        throw new Error("This workspace has no .bb checkout to publish from.");
      }
      const result = await host.call(
        "pushGuidance",
        {
          projectSourcePath: manifest.projectSourcePath,
          workspaceBbPath: source.path,
          // The calling thread, not the workspace's creator: two threads
          // sharing one checkout must not push onto one `guidance-<thread>`
          // ref and silently overwrite each other's proposal.
          threadId: threadId ?? manifest.threadId,
        },
        { hostId: manifest.hostId, timeoutMs: ACTION_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
      );
      if (!result.ok) throw new Error(result.message);
      changed();
      return result.message;
    },
  });

  /* ------------------------------------------------------------ the CLI */

  /**
   * `bb repos`.
   *
   * Worth having because there is no project-settings slot among the plugin
   * app slots, so the repo list lives in a plugin nav panel rather than beside
   * bb's own project settings. Someone looking in the obvious place will not
   * find it; this is the answer for them and for an agent that would rather
   * run a command than open a panel.
   */
  /**
   * The project a command acts on: an explicit `--project` first, then the
   * ambient thread or project.
   *
   * The explicit flag is what makes the CLI usable for setting a *new*
   * project up. Without it every command targets wherever it happens to be
   * run, which is never the project being created.
   */
  async function resolveProjectId(
    ctx: { projectId?: string | null; threadId?: string | null },
    explicit?: string,
  ): Promise<string> {
    if (explicit !== undefined && explicit.length > 0) {
      // Fail here rather than deeper, where a bad id reads as "this project
      // has no checkout on any machine".
      try {
        await bb.sdk.projects.get({ projectId: explicit });
      } catch {
        throw new PluginCliError(`No project with id ${explicit}.`, {
          code: "unknown_project",
          hint: "List them with `bb project list`.",
        });
      }
      return explicit;
    }
    if (typeof ctx.projectId === "string" && ctx.projectId.length > 0) return ctx.projectId;
    if (typeof ctx.threadId === "string" && ctx.threadId.length > 0) {
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
      if (thread.projectId.length > 0) return thread.projectId;
    }
    throw new PluginCliError("No project in context.", {
      code: "project_required",
      hint: "Pass --project <id> (list them with `bb project list`), or run this inside a project thread.",
    });
  }

  /** The `--project` option, identical on every project-scoped command. */
  const PROJECT_OPTION = {
    type: "string",
    description: "Project ID to act on; defaults to the project in context",
    aliases: ["project-id", "proj"],
  } as const;

  async function requireSource(projectId: string): Promise<SourceLocation> {
    const location = await projectSource(projectId);
    if (location === null) {
      throw new PluginCliError("This project has no checkout on any machine.", {
        code: "no_project_source",
        hint: "Add a project source in bb's project settings first.",
      });
    }
    return location;
  }

  bb.cli.register(
    defineCli({
      name: "repos",
      summary: "The multi-repo workspace's repo set",
      commands: {
        list: cliCommand({
          summary: "List the project's repo set and the state of each one's object cache",
          options: {
            project: PROJECT_OPTION,
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const location = await requireSource(await resolveProjectId(ctx, input.options.project));
            const set = await readRepoSet(location, { bootstrap: false }, ctx.signal);
            if (set.file === null) {
              throw new PluginCliError(set.error ?? `${REPOS_FILE} could not be read.`, {
                code: "invalid_repos_json",
                hint: `Fix ${REPOS_FILE} in ${location.path}.`,
              });
            }
            const cache = await host.call(
              "cacheStatus",
              { repos: set.file.repos.map((repo) => ({ url: repo.url })) },
              { hostId: location.hostId, timeoutMs: READ_TIMEOUT_MS, signal: ctx.signal },
            );
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ source: location, repos: set.file.repos, cache: cache.entries }, null, 2),
              };
            }
            if (set.file.repos.length === 0) {
              return { exitCode: 0, stdout: `No repos configured in ${location.path}/${REPOS_FILE}.` };
            }
            const byUrl = new Map(cache.entries.map((entry) => [entry.url, entry]));
            const lines = set.file.repos.map((repo) => {
              const entry = byUrl.get(repo.url);
              const state = entry === undefined || !entry.present ? "not cached" : describeCacheEntry(entry);
              return `${repo.dir}\t${repo.branch ?? "(default)"}\t${repo.url}\t${state}`;
            });
            return { exitCode: 0, stdout: ["dir\tbranch\turl\tcache", ...lines].join("\n") };
          },
        }),

        add: cliCommand({
          summary: "Add a repo to the project's repo set",
          positionals: [{ name: "url", description: "Anything git can clone, including a local path", required: true }],
          options: {
            project: PROJECT_OPTION,
            dir: { type: "string", description: "Directory name inside each workspace (default: the repo's name)" },
            branch: { type: "string", description: "Base branch (default: the repo's default branch)" },
          },
          async run(input, ctx) {
            const location = await requireSource(await resolveProjectId(ctx, input.options.project));
            const outcome = await addRepoToProject(
              location,
              {
                ...(input.options.dir === undefined ? {} : { dir: input.options.dir }),
                url: input.positionals.url,
                ...(input.options.branch === undefined ? {} : { branch: input.options.branch }),
              },
              ctx.signal,
            );
            if (!outcome.ok) {
              throw new PluginCliError(outcome.error, {
                code: outcome.code,
                ...(outcome.code === "dir_required" ? { hint: "Pass --dir <name>." } : {}),
              });
            }
            return {
              exitCode: 0,
              stdout: `Added ${outcome.dir}. New threads in this project will get it; existing workspaces are unchanged.`,
            };
          },
        }),

        remove: cliCommand({
          summary: "Remove a repo from the project's repo set",
          positionals: [{ name: "dir", description: "The directory name in the repo set", required: true }],
          options: { project: PROJECT_OPTION },
          async run(input, ctx) {
            const location = await requireSource(await resolveProjectId(ctx, input.options.project));
            const outcome = await removeRepoFromProject(location, input.positionals.dir, ctx.signal);
            if (!outcome.ok) throw new PluginCliError(outcome.error, { code: outcome.code });
            return { exitCode: 0, stdout: `Removed ${outcome.dir}. Existing workspaces are unchanged.` };
          },
        }),

        status: cliCommand({
          summary: "Show this thread's workspace: each repo's branch and working-tree state",
          async run(_input, ctx) {
            if (typeof ctx.threadId !== "string" || ctx.threadId.length === 0) {
              throw new PluginCliError("No thread in context.", {
                code: "thread_required",
                hint: "Run `bb repos status` from inside a thread.",
              });
            }
            const manifest = await resolveManifest(ctx.threadId);
            if (manifest === null) {
              return { exitCode: 0, stdout: "This thread does not have a multi-repo workspace." };
            }
            const live = await host.call(
              "workspaceStatus",
              { repos: manifest.repos.filter((r) => r.status === "ready").map(toTarget) },
              { hostId: manifest.hostId, timeoutMs: READ_TIMEOUT_MS, signal: ctx.signal },
            );
            const lines = live.repos.map(
              (repo) =>
                `${repo.dir}\t${repo.branch ?? "-"}\t+${repo.ahead}/-${repo.behind}\t${repo.dirty} changed, ${repo.untracked} untracked${repo.error === null ? "" : `\t${repo.error}`}`,
            );
            const shared = sharingThreads(manifest, ctx.threadId);
            return {
              exitCode: 0,
              stdout: [
                `${manifest.root} (branch ${manifest.branchName})`,
                ...(shared.length === 0
                  ? []
                  : [
                      `Shared with ${shared.length} other thread(s): ${shared.join(", ")} — same directory, same branch.`,
                    ]),
                "",
                "dir\tbranch\tahead/behind\tworking tree",
                ...lines,
              ].join("\n"),
            };
          },
        }),
      },
    }),
  );

  function describeCacheEntry(entry: CacheEntry): string {
    const age = entry.fetchedAt === null ? "never fetched" : `fetched ${relativeTime(entry.fetchedAt)}`;
    const size = entry.sizeBytes === null ? "" : `, ${(entry.sizeBytes / 1024 / 1024).toFixed(1)} MB`;
    return `${age}${size}`;
  }

  function relativeTime(at: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 90) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
  }

  function toTarget(repo: WorkspaceRepo): RepoTarget {
    return { dir: repo.dir, path: repo.path, baseBranch: repo.baseBranch };
  }

  /* ------------------------------------------------------------ the RPC */

  bb.rpc.register(rpcContract, {
    async projects() {
      const all = await bb.sdk.projects.list();
      return {
        projects: all.map((project) => ({
          id: project.id,
          name: project.name,
          hasSource: project.sources.some((source) => source.type === "local_path"),
        })),
      };
    },

    async repoSet({ projectId }) {
      const location = await projectSource(projectId);
      if (location === null) {
        return { projectSourcePath: null, hostId: null, reposJson: null, repos: [], error: null, cache: [] };
      }
      try {
        const set = await readRepoSet(location, { bootstrap: false });
        const repos =
          set.file === null
            ? []
            : set.file.repos.map((repo) => ({ dir: repo.dir, url: repo.url, branch: repo.branch ?? null }));
        const cache =
          set.file === null
            ? []
            : (
                await host.call(
                  "cacheStatus",
                  { repos: set.file.repos.map((repo) => ({ url: repo.url })) },
                  { hostId: location.hostId, timeoutMs: READ_TIMEOUT_MS },
                )
              ).entries;
        return {
          projectSourcePath: location.path,
          hostId: location.hostId,
          reposJson: set.text,
          repos,
          error: set.error,
          cache,
        };
      } catch (error) {
        return {
          projectSourcePath: location.path,
          hostId: location.hostId,
          reposJson: null,
          repos: [],
          error: errorMessage(error),
          cache: [],
        };
      }
    },

    async saveRepoSet({ projectId, reposJson }) {
      const location = await projectSource(projectId);
      if (location === null) return { ok: false, error: "This project has no checkout on any machine." };
      // Validated here as well as in the panel: the panel's copy of the rules
      // is a convenience, and this is the boundary.
      const parsed = parseReposFile(reposJson);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      try {
        // Bootstrap first. On a project whose `.bb` does not exist yet — a
        // brand new one, on a machine whose workspace directory is still
        // empty — writing straight through would fail on the missing
        // directory, which made this panel unable to be the thing that sets a
        // project up. Committing a repo set is a deliberate enough act to
        // stand up the repo that holds it.
        await host.call(
          "prepareProjectSource",
          { path: location.path, fetchTtlMs: CACHE_FRESH_MS, bootstrap: true },
          { hostId: location.hostId, timeoutMs: READ_TIMEOUT_MS },
        );
        await writeRepoSet(location, parsed.value, `Update the repo set`);
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },

    async addRepo({ projectId, repo }) {
      const location = await projectSource(projectId);
      if (location === null) return { ok: false, error: "This project has no checkout on any machine." };
      try {
        const outcome = await addRepoToProject(location, repo);
        return outcome.ok ? { ok: true, error: null } : { ok: false, error: outcome.error };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },

    async removeRepo({ projectId, dir }) {
      const location = await projectSource(projectId);
      if (location === null) return { ok: false, error: "This project has no checkout on any machine." };
      try {
        const outcome = await removeRepoFromProject(location, dir);
        return outcome.ok ? { ok: true, error: null } : { ok: false, error: outcome.error };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },

    async setRepoBranch({ projectId, dir, branch }) {
      const location = await projectSource(projectId);
      if (location === null) return { ok: false, error: "This project has no checkout on any machine." };
      try {
        const outcome = await setProjectRepoBranch(location, dir, branch);
        return outcome.ok ? { ok: true, error: null } : { ok: false, error: outcome.error };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },

    async suggestRepos({ hostId, path }) {
      return { checkouts: await localCheckouts(hostId, path) };
    },

    async hosts() {
      const [all, config] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.system.config()]);
      return {
        hosts: all
          .filter((entry) => entry.lifecycle.phase === "active")
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            connected: entry.status === "connected",
            primary: entry.id === config.primaryHostId,
          })),
      };
    },

    async suggestProjectSource({ hostId, name }) {
      return host.call("suggestProjectSourcePath", { name }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },

    async createProject({ name, hostId, path, source }) {
      const warnings: string[] = [];
      const fail = (error: string) => ({ ok: false as const, projectId: null, error, warnings });

      // Refuse to stack a second project on a directory one already owns. Core
      // may or may not reject it, and either way the panel would then show two
      // projects editing one repos.json.
      const existing = await bb.sdk.projects.list({ includePersonal: true });
      const taken = existing.find((project) =>
        project.sources.some((entry) => entry.type === "local_path" && entry.hostId === hostId && entry.path === path),
      );
      if (taken !== undefined) return fail(`${path} is already the source of the project "${taken.name}".`);

      // The git work first: a failure here leaves no project behind.
      try {
        if (source.kind === "fresh") {
          const resolved = resolveSeed(source.repos);
          if (!resolved.ok) return fail(resolved.error);
          const prepared = await host.call(
            "prepareProjectSource",
            { path, fetchTtlMs: CACHE_FRESH_MS, bootstrap: true, seed: source.repos },
            { hostId, timeoutMs: READ_TIMEOUT_MS },
          );
          warnings.push(...prepared.warnings);
          if (!prepared.bootstrapped && source.repos.length > 0) {
            // Adopting a directory that is already a `.bb` repo: the seed was
            // not written, so merge the entries in the ordinary way.
            const location: SourceLocation = { hostId, path };
            for (const entry of source.repos) {
              const outcome = await addRepoToProject(location, entry);
              if (!outcome.ok) warnings.push(outcome.error);
            }
          }
        } else {
          const cloned = await host.call(
            "cloneProjectSource",
            { url: source.url, path },
            { hostId, timeoutMs: CREATE_TIMEOUT_MS },
          );
          if (!cloned.ok) return fail(cloned.message ?? "Could not clone the .bb repo.");
        }
      } catch (error) {
        return fail(errorMessage(error));
      }

      try {
        const project = await bb.sdk.projects.create({
          name,
          source: { type: "local_path", hostId, path },
        });
        changed();
        return { ok: true, projectId: project.id, error: null, warnings: warnings.slice(0, 20) };
      } catch (error) {
        return fail(
          `${path} is ready but the project could not be created: ${errorMessage(error)}. Try again, or create it with \`bb project create --root ${path}\`.`,
        );
      }
    },

    async workspace({ threadId }) {
      const manifest = await resolveManifest(threadId);
      if (manifest === null) return { workspace: null };
      return {
        workspace: {
          root: manifest.root,
          branchName: manifest.branchName,
          hostId: manifest.hostId,
          projectSourcePath: manifest.projectSourcePath,
          repos: manifest.repos,
          sharedWith: await describeSharing(manifest, threadId),
        },
      };
    },

    async workspaceStatus({ threadId }) {
      const manifest = await resolveManifest(threadId);
      if (manifest === null) return { repos: [] };
      const result = await host.call(
        "workspaceStatus",
        { repos: readyRepos(manifest).map(toTarget) },
        { hostId: manifest.hostId, timeoutMs: READ_TIMEOUT_MS },
      );
      return { repos: result.repos };
    },

    async changes({ threadId }) {
      const manifest = await resolveManifest(threadId);
      if (manifest === null) return { repos: [] };
      const result = await host.call(
        "diffSummary",
        { repos: readyRepos(manifest).map(toTarget), maxFiles: MAX_DIFF_FILES },
        { hostId: manifest.hostId, timeoutMs: READ_TIMEOUT_MS },
      );
      return { repos: result.repos };
    },

    async filePatch({ threadId, dir, file, untracked }) {
      const manifest = await resolveManifest(threadId);
      const repo = manifest?.repos.find((entry) => entry.dir === dir);
      if (manifest === null || repo === undefined) {
        return { patch: "", truncated: false, error: "That repo is not in this workspace." };
      }
      return host.call(
        "diffFile",
        {
          repoPath: repo.path,
          baseBranch: repo.baseBranch,
          file,
          untracked,
          maxBytes: MAX_PATCH_BYTES,
        },
        { hostId: manifest.hostId, timeoutMs: READ_TIMEOUT_MS },
      );
    },

    async pullRequests({ threadId, refresh }) {
      const manifest = await resolveManifest(threadId);
      if (manifest === null) return { repos: [], fetchedAt: null };
      const work = readyRepos(manifest).filter((repo) => repo.dir !== PROJECT_SOURCE_DIR);

      if (!refresh) {
        const cached = readPrCache(threadId, work.map((repo) => repo.dir));
        if (cached !== null) return cached;
      }
      const result = await host.call(
        "pullRequests",
        { repos: work.map((repo) => ({ dir: repo.dir, path: repo.path })), branch: manifest.branchName },
        { hostId: manifest.hostId, timeoutMs: READ_TIMEOUT_MS },
      );
      const fetchedAt = Date.now();
      writePrCache(threadId, result.repos, fetchedAt);
      return { repos: result.repos, fetchedAt };
    },

    async pullRequestAction({ threadId, dir, action }) {
      const manifest = await resolveManifest(threadId);
      const repo = manifest?.repos.find((entry) => entry.dir === dir);
      if (manifest === null || repo === undefined) {
        return { ok: false, message: "That repo is not in this workspace.", url: null };
      }
      const full =
        action.kind === "create"
          ? { ...action, base: repo.baseBranch }
          : action;
      const result = await host.call(
        "pullRequestAction",
        { repoPath: repo.path, branch: repo.branch, action: full },
        { hostId: manifest.hostId, timeoutMs: ACTION_TIMEOUT_MS },
      );
      // Any write invalidates the read, whether or not it succeeded: a failed
      // merge still may have changed the PR's mergeability.
      db.prepare(`DELETE FROM pr_cache WHERE thread_id = ? AND dir = ?`).run(threadId, dir);
      threadChanged(threadId, { pullRequests: true });
      return result;
    },
  });

  /**
   * The other threads working in this checkout, named.
   *
   * Worth the SDK calls because an id is not an answer: the panel is telling
   * someone their branch has a second author on it, and "thr_948yb2g8wz" does
   * not tell them who. Capped by `sharingThreads`, and a thread that cannot be
   * read is still reported — a warning that disappears on a transient failure
   * is worse than one with a missing name.
   */
  async function describeSharing(
    manifest: WorkspaceManifest,
    threadId: string,
  ): Promise<{ threadId: string; title: string | null }[]> {
    const ids = sharingThreads(manifest, threadId);
    return Promise.all(
      ids.map(async (id) => {
        try {
          const thread = await bb.sdk.threads.get({ threadId: id });
          return { threadId: id, title: thread.title ?? thread.titleFallback };
        } catch {
          return { threadId: id, title: null };
        }
      }),
    );
  }

  /** All of a thread's cached PR rows, or null when any is missing or stale. */
  function readPrCache(
    threadId: string,
    dirs: readonly string[],
  ): { repos: RepoPullRequest[]; fetchedAt: number } | null {
    if (dirs.length === 0) return { repos: [], fetchedAt: Date.now() };
    const rows = db
      .prepare(`SELECT dir, payload, fetched_at FROM pr_cache WHERE thread_id = ?`)
      .all(threadId) as { dir: string; payload: string; fetched_at: number }[];
    const byDir = new Map(rows.map((row) => [row.dir, row]));
    const cutoff = Date.now() - PR_CACHE_TTL_MS;
    const repos: RepoPullRequest[] = [];
    let oldest = Number.POSITIVE_INFINITY;
    for (const dir of dirs) {
      const row = byDir.get(dir);
      if (row === undefined || row.fetched_at < cutoff) return null;
      try {
        repos.push(JSON.parse(row.payload) as RepoPullRequest);
      } catch {
        return null;
      }
      oldest = Math.min(oldest, row.fetched_at);
    }
    return { repos, fetchedAt: oldest };
  }

  function writePrCache(threadId: string, repos: readonly RepoPullRequest[], fetchedAt: number): void {
    const statement = db.prepare(
      `INSERT INTO pr_cache (thread_id, dir, payload, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (thread_id, dir) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
    );
    for (const repo of repos) statement.run(threadId, repo.dir, JSON.stringify(repo), fetchedAt);
  }

  /* ---------------------------------------------------- background sweep */

  /**
   * Keep the object cache warm, so a cold start is rare rather than routine.
   *
   * Fetching synchronously on every thread start would put a network round
   * trip per repo between pressing New thread and getting a workspace. This
   * does the same work off the critical path, per machine, and only for
   * entries that already exist — cloning a repo nobody has opened yet would
   * pay a cold start on a machine that may never need it.
   */
  bb.background.schedule("refresh-caches", "17 * * * *", async () => {
    const rows = db.prepare(`SELECT DISTINCT host_id, repos FROM workspaces`).all() as {
      host_id: string;
      repos: string;
    }[];
    const byHost = new Map<string, Set<string>>();
    for (const row of rows) {
      let repos: WorkspaceRepo[];
      try {
        repos = JSON.parse(row.repos) as WorkspaceRepo[];
      } catch {
        continue;
      }
      const urls = byHost.get(row.host_id) ?? new Set<string>();
      for (const repo of repos) {
        if (repo.dir !== PROJECT_SOURCE_DIR && repo.remote.length > 0) urls.add(repo.remote);
      }
      byHost.set(row.host_id, urls);
    }
    for (const [hostId, urls] of byHost) {
      try {
        await host.call(
          "refreshCaches",
          { repos: [...urls].slice(0, 200).map((url) => ({ url })), maxAgeMs: CACHE_BACKGROUND_MS },
          { hostId, timeoutMs: 30 * 60 * 1000 },
        );
      } catch (error) {
        // A machine that is asleep or offline is the normal case, not a fault.
        bb.log.debug(`Cache refresh skipped for ${hostId}: ${errorMessage(error)}`);
      }
    }
  });

  bb.log.info(`Multi-repo workspaces ready (max ${MAX_REPOS} repos per project).`);
}
