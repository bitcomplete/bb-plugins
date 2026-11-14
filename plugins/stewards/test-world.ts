// The fake world and plugin harness shared by the stewards tests: multi-repo
// serving `.bb`, linear and github serving snapshots, and bb's threads. Moved
// out of server.test.ts unchanged so a second test file can run a real
// reconcile over the same harness (BB-297). Not loaded by the plugin.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { PROJECT_FILE, playbookPath } from "./config.js";
import { createStewardsPlugin, SECRET_SETTING_NAMES, testHooks, type StewardsDeps } from "./server.js";
import { SOURCE_PLUGIN_IDS, sourceContract, type EntitySnapshot } from "./source-contract.js";
import { GITHUB_PRS, GITHUB_REVIEWS, LINEAR_TICKETS, projectFileTemplate } from "./templates.js";


type Call = { pluginId: string; method: string; input: Record<string, unknown> };

export function world() {
  const files: Record<string, string | null> = {
    [PROJECT_FILE]: projectFileTemplate(["ENG"]),
    [playbookPath("linear-tickets")]: LINEAR_TICKETS,
    [playbookPath("github-prs")]: GITHUB_PRS,
    [playbookPath("github-reviews")]: GITHUB_REVIEWS,
  };
  const repos = [{ dir: "web", url: "https://github.com/acme/web.git" }];
  /** The primary repo a lesson's pull request opens on (BB-108). */
  let primary: { dir: string; url: string } | null = { dir: "bb", url: "https://github.com/acme/bb.git" };
  let layout: "primary" | "directory" = "primary";
  const entities = new Map<string, EntitySnapshot>();
  /** Dependabot alerts the fake github serves, by lowercased repo. */
  const dependabotAlerts = new Map<string, unknown[]>();
  /** Repos whose dependency graph parsed no manifests, lowercased, for the graph-empty wake (BB-289). */
  const dependabotGraphEmpty = new Set<string>();
  /** Entity ids whose snapshot read throws, for the failed-read test (BB-115). */
  const snapshotErrors = new Set<string>();
  /** The fake linear dedup search: unsupported (github-style decline) or an error, for BB-136. */
  let searchUnsupported = false;
  let searchError: string | null = null;
  /** The login `sourceValidate` reports, per source; tests override one to make it unreadable (BB-105). */
  const viewers: Partial<Record<"linear" | "github", string | null>> = {};
  /** Labels a fake source reports missing for a unit, by `${source}:${lowercased unit}` (BB-235). */
  const missingStates = new Map<string, string[]>();
  /** Labels a fake source reports absent for a unit, by `${source}:${lowercased unit}` (BB-248). */
  const missingLabels = new Map<string, string[]>();
  /** The Linear teams `sourceValidate` reports as the viewer's, for `init` with no `--teams` (BB-234). */
  let linearMine: Array<{ unit: string; name: string }> = [{ unit: "ENG", name: "Engineering" }];
  /** Deployments the fake github serves, by `lowercased repo lowercased environment`. */
  const sourceDeployments = new Map<string, unknown[]>();
  /** Files the fake github serves, by `lowercased repo path ref` (BB-132). */
  const sourceFiles = new Map<string, string>();
  /** Commits the fake github serves, by `lowercased repo path until` (BB-132). */
  const sourceCommits = new Map<string, string>();
  /** Workflow runs the fake github serves, by `lowercased repo run id` (BB-132). */
  const sourceRuns = new Map<string, unknown>();
  /** Compare statuses the fake github serves, by `lowercased repo base head` (BB-132). */
  const sourceCompares = new Map<string, string>();
  /** Every `sourceEnsureLabel` call, in order (BB-236). */
  const labelEnsureCalls: Array<{ source: string; units: string[]; label: string }> = [];
  /** Units a fake source already carries the label in, so a second ensure is `existed` (BB-236). */
  const labelsEnsured = new Set<string>();
  /** Units whose `sourceEnsureLabel` call fails, by `${source}:${lowercased unit}` (BB-236). */
  const labelEnsureFailures = new Map<string, string>();
  /** When true, the fake source does not serve `sourceEnsureLabel` at all (BB-236). */
  let labelEnsureUnavailable = false;
  /** When true, the fake push-notifications plugin does not serve its methods (BB-253). */
  let pushUnavailable = false;
  /** A plain thrown failure for `sourceEnsureLabel`, to tell it from unavailable (BB-236). */
  let labelEnsureThrow: string | null = null;
  const rpcCalls: Call[] = [];
  const threads = new Map<string, { status: string; archivedAt: number | null; visibility?: string; title?: string | null; parentThreadId?: string | null; lifecycleOwnerThreadId?: string | null; parentNotifications?: string; sectionId?: string | null; projectId?: string; hostId?: string; providerId?: string; model?: string | null; reasoningLevel?: string | null; environmentProviderId?: string | null; branchName?: string | null; environmentStatus?: string | null; environmentPhase?: string | null; sendError?: { code: string; status: number; message: string } }>();
  /** Every `threads.delete` the plugin asked for; the plugin must only ever archive. */
  const deletes: string[] = [];
  const writes: Array<{ path: string; hostId?: string }> = [];
  /** Dotenv files by `${hostId}:${path}`, for `bb stewards secret import`. */
  const fileContents = new Map<string, string>();
  /** Files `bb stewards init` wrote, by absolute path, so a test can apply and re-read them. */
  const writtenContent = new Map<string, string>();
  const fileKey = (hostId: string | undefined, path: string) => `${hostId ?? ""}:${path}`;
  const sections: Array<{ id: string; name: string }> = [];
  /** What `projects.list` answers; a test empties it to delete the project. */
  const projectList: Array<{ id: string; name: string }> = [{ id: "p1", name: "Acme" }];
  /** Each thread's latest context window reading, as bb reports it. */
  const usage = new Map<string, number>();
  const metadata = new Map<string, Record<string, unknown>>();
  /** The fake server's UI preferences, keyed by preference key. */
  const uiPreferences = new Map<string, { value: unknown; revision: number }>([["sidebar.threadListProvider", { value: "__automatic__", revision: 0 }]]);
  /** Every `system.uiPreferences.set` the plugin made, for the load-time pin's tests. */
  const uiPreferencesWrites: Array<{ key: string; value: unknown; expectedRevision: number }> = [];
  const spawns: Array<Record<string, unknown> & { id: string }> = [];
  const sends: Array<{ threadId: string; text: string; at?: number }> = [];
  /** Every `threads.retry` the plugin made (BB-255). */
  const retries: Array<{ threadId: string; turnRequestId: string; sendAt?: number; reason?: string }> = [];
  /** The `client/turn/requested` events a retry leaves, for the chain-root read (BB-255). */
  const retryEvents: Array<{ threadId: string; requestId: string; retryOfRequestId: string }> = [];
  /** Whether `threads.retry` answers 409 `retry_already_queued` (BB-255). */
  let retryConflict = false;
  /** Whether `threads.retry` returns a queued row instead of a sent one (BB-255). */
  let retryQueued = false;
  /** Every queued retry row the plugin deleted (BB-255). */
  const queuedDeletes: Array<{ threadId: string; queuedMessageId: string }> = [];
  const userTurns: Array<{ threadId: string; text: string; at?: number }> = [];
  /** What the page's GitHub actions did. */
  const githubComments: Array<{ repo: string; number: number; body: string }> = [];
  const githubReviews: Array<{ repo: string; number: number; event: string; body: string }> = [];
  const githubMerges: Array<{ repo: string; number: number; title: string; body: string }> = [];
  /** Workflow dispatches the fake github serves, in order (BB-216). */
  const githubDispatches: Array<{ repo: string; workflow: string; ref: string; inputs: Record<string, string> }> = [];
  /** Every lesson pull request the plugin opened, and every one it closed (BB-108). */
  const githubPulls: Array<{ repo: string; head: string; base: string; title: string; body: string; url: string; number: number }> = [];
  const githubClosedPulls: Array<{ repo: string; number: number }> = [];
  const githubDefaultBranches = new Map<string, string>();
  /** Branches the test registered as existing, for the BB-287 recovery read. */
  const githubBranches = new Set<string>();
  /** The survey's GitHub reads: a recursive tree, branch protection, labels and file text. */
  const githubTrees = new Map<string, Array<{ path: string; type: string }>>();
  const githubBranchProtection = new Map<string, { protected: boolean; requiredApprovingReviewCount: number | null; requiresStatusChecks: boolean }>();
  const githubLabels = new Map<string, string[]>();
  let pullNumber = 0;
  let createPullError: string | null = null;
  let mergePullError: string | null = null;
  /** A forced failure for `threads.spawn`, to exercise the follow-up spawn's error path (BB-313). */
  let spawnError: string | null = null;
  /** A delay before `threads.spawn` resolves, to interleave a write with a follow-up spawn (BB-313). */
  let spawnDelayMs = 0;
  /** When set, the pull request's head moves during `pullDetails`, so the merge PUT sees a stale head and GitHub refuses with 409 (BB-257). */
  let moveHeadOnMerge = false;
  /** A forced failure for `github.dispatchWorkflow`, to exercise the best-effort dispatch after a merge (BB-216). */
  let mergeDispatchError: string | null = null;
  /** A forced failure for `github.pullDetails`, to exercise the merge title fallback (BB-193). */
  let pullDetailsError: string | null = null;
  /** The changed paths `github.files` reports, by "owner/repo#n". */
  const githubFiles = new Map<string, string[]>();
  /** Overrides for `github.fileContent`, by "owner/repo#n:path". */
  const githubFileContents = new Map<string, string>();
  const github = {
    comment: async (repo: string, number: number, body: string) => {
      githubComments.push({ repo, number, body });
      return `IC_${githubComments.length}`;
    },
    review: async (repo: string, number: number, event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", body: string) => {
      githubReviews.push({ repo, number, event, body });
    },
    squashMerge: async (repo: string, number: number, title: string, body: string, sha?: string | null) => {
      if (mergePullError !== null) throw new Error(mergePullError);
      const key = `${repo}#${number}`;
      const e = entities.get(key);
      // The real PUT names the head the caller judged; GitHub refuses with 409
      // when the head moved (BB-257).
      if (sha !== undefined && sha !== null && sha !== "" && e !== undefined && e.pull !== null && e.pull.headSha !== sha) {
        throw new Error(`PUT /repos/${repo}/pulls/${number}/merge failed: 409 {"message":"Head branch was modified. Review and try the merge again."}`);
      }
      githubMerges.push({ repo, number, title, body });
      // The real merge changes the pull request's state; the fake must too, or
      // the plugin's own gate-met merge (BB-257) and the reconcile it
      // schedules would merge the same open snapshot again in a loop.
      if (e !== undefined && e.pull !== null) entities.set(key, { ...e, state: "merged", pull: { ...e.pull, merged: true, mergeCommit: "c".repeat(40) } });
      return { sha: "c".repeat(40) };
    },
    // The real writer reads the pull request's title and body from GitHub; the
    // fake reads the entity the test registered, so a merge test gets the PR's
    // own title unless it forces a read failure (BB-193).
    pullDetails: async (repo: string, number: number) => {
      if (pullDetailsError !== null) throw new Error(pullDetailsError);
      const entity = entities.get(`${repo}#${number}`);
      if (entity === undefined || entity.title === null || entity.title.trim() === "") return null;
      // A push between the look and the merge: the head the plugin judged is
      // no longer the head, so the merge PUT must be refused (BB-257).
      if (moveHeadOnMerge && entity.pull !== null) entities.set(`${repo}#${number}`, { ...entity, pull: { ...entity.pull, headSha: "ddddddd4" } });
      return { title: entity.title, body: entity.description ?? "" };
    },
    files: async (repo: string, number: number) => {
      const explicit = githubFiles.get(`${repo}#${number}`);
      if (explicit !== undefined) return explicit;
      // A lesson PR's changed file is the one named in its body.
      const pr = githubPulls.find((p) => p.repo === repo && p.number === number);
      const m = pr === undefined ? null : /in `([^`]+)`/u.exec(pr.body);
      return m === null ? [] : [`.bb/${m[1]}`];
    },
    fileContent: async (repo: string, path: string, ref: string) => {
      const explicit = githubFileContents.get(`${repo}#${ref}:${path}`);
      if (explicit !== undefined) return explicit;
      // The branch ref carries the latest publish, so the last PR on it.
      const pr = githubPulls.filter((p) => p.repo === repo && (p.head === ref || `refs/heads/${p.head}` === ref)).at(-1);
      if (pr === undefined) return null;
      const m = /in `([^`]+)`/u.exec(pr.body);
      return m === null || path !== `.bb/${m[1]}` ? null : pr.body;
    },
    defaultBranch: async (repo: string) => githubDefaultBranches.get(repo) ?? "main",
    // The real writer lists a repo's pull requests filtered by head branch
    // (BB-264); the fake scans the entities the test registered.
    pullByHead: async (repo: string, head: string) => {
      for (const e of entities.values()) {
        if (e.pull === null || e.pull.head !== head) continue;
        if (e.unit.toLowerCase() !== repo.toLowerCase()) continue;
        const number = Number(/(\d+)$/u.exec(e.key)?.[1] ?? "");
        if (!Number.isInteger(number) || number <= 0) continue;
        return { number, key: e.key, state: e.state, merged: e.pull.merged === true || e.state.toLowerCase() === "merged", headSha: e.pull.headSha };
      }
      return null;
    },
    // BB-287: the open pull requests whose base is `base`, the stacked-on-me
    // check. The fake scans the entities the test registered.
    openPullsByBase: async (repo: string, base: string) => {
      const pulls: Array<{ number: number; key: string; state: string }> = [];
      for (const e of entities.values()) {
        if (e.pull === null || e.pull.base !== base) continue;
        if (e.unit.toLowerCase() !== repo.toLowerCase()) continue;
        if (e.pull.merged === true || e.state.toLowerCase() === "merged" || e.state.toLowerCase() === "closed") continue;
        const number = Number(/(\d+)$/u.exec(e.key)?.[1] ?? "");
        if (!Number.isInteger(number) || number <= 0) continue;
        pulls.push({ number, key: e.key, state: e.state });
      }
      return pulls;
    },
    // BB-287: a branch the test registered as existing; a base branch absent
    // from the set is gone, which fires the recovery wake for a closed stacked
    // pull request.
    branchExists: async (repo: string, branch: string) => githubBranches.has(`${repo.toLowerCase()} ${branch}`),
    dispatchWorkflow: async (repo: string, workflow: string, ref: string, inputs: Record<string, string>) => {
      if (mergeDispatchError !== null) throw new Error(mergeDispatchError);
      githubDispatches.push({ repo, workflow, ref, inputs });
    },
    tree: async (repo: string) => githubTrees.get(repo.toLowerCase()) ?? [],
    branchProtection: async (repo: string, branch: string) => githubBranchProtection.get(`${repo.toLowerCase()} ${branch}`) ?? null,
    labels: async (repo: string) => githubLabels.get(repo.toLowerCase()) ?? [],
    createPull: async (repo: string, args: { head: string; base: string; title: string; body: string }) => {
      if (createPullError !== null) throw new Error(createPullError);
      const number = ++pullNumber;
      const url = `https://github.com/${repo}/pull/${number}`;
      githubPulls.push({ repo, ...args, url, number });
      return { url, number };
    },
    closePull: async (repo: string, number: number) => {
      githubClosedPulls.push({ repo, number });
    },
  };
  let n = 0;

  // BB-300: the voice-transcription plugin as the stand-up sees it. Tests set
  // the endpoint, the AI-service status and a refusal; the default is a ready
  // OpenAI endpoint, so a stand-up can start.
  const realtimeOpens: Array<{ input: Record<string, unknown>; sessionId: string }> = [];
  let voiceBaseUrl = "https://api.openai.com/v1";
  let voiceServicePresent = true;
  let voiceServiceReady = true;
  let voiceServiceMessage = "Set the API key in Settings → Plugins → Voice transcription";
  let voiceSettingsThrow: string | null = null;
  let voiceRealtimeRefusal: string | null = null;
  let realtimeSessionSeq = 0;

  const callRpc = async (args: { pluginId: string; method: string; input?: unknown; outputSchema: { parse(v: unknown): unknown } }) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    rpcCalls.push({ pluginId: args.pluginId, method: args.method, input });
    let out: unknown;
    if (args.pluginId === "push-notifications") {
      // BB-253: the fake serves the two published RPCs the stewards plugin
      // calls; `setPushUnavailable` makes them unknown-method, for the
      // "not available" path.
      if (pushUnavailable) throw Object.assign(new Error(`Unknown RPC method: ${args.method}`), { code: "unknown_method" });
      if (args.method === "threadNotifications.set") out = { own: "muted", ancestorCap: null };
      else if (args.method === "notifications.send") out = { ok: true, channels: ["web"] };
      else throw Object.assign(new Error(`unknown ${args.pluginId}.${args.method}`), { status: 404 });
    } else if (args.method === "readProjectFiles") {
      const paths = input.paths as string[];
      if (paths.some((path) => path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))) throw new Error(`bad project file path: ${paths.join(", ")}`);
      out = { projectSourcePath: "/p/.bb", head: "abc", files: paths.map((path) => ({ path, content: files[path] ?? null })), error: null };
    }
    else if (args.method === "repoSet") out = { repos, primary, layout, error: null };
    else if (args.method === "sourceSnapshot") {
      if (snapshotErrors.has(String(input.id))) throw new Error("Linear rate limited the read");
      const entity = entities.get(String(input.id)) ?? null;
      // BB-322: the real source's snapshot carries the pull request's changed
      // files; the test world keeps them beside the entity. Merge them so the
      // assessment's decide-list mark reads the same files `pullChangedFiles`
      // returns, exactly as production does.
      const files = entity !== null && entity.pull !== null ? githubFiles.get(entity.key) : undefined;
      out = { snapshot: entity === null || entity.pull === null || files === undefined ? entity : { ...entity, pull: { ...entity.pull, files } } };
    }
    else if (args.method === "sourceSetInterest") out = { ok: true };
    else if (args.method === "sourceAdoptable") {
      const units = input.units as string[];
      out = {
        viewer: args.pluginId === SOURCE_PLUGIN_IDS.github ? "jane" : "Jane",
        entities: [...entities.values()]
          .filter((e) => SOURCE_PLUGIN_IDS[e.source] === args.pluginId && units.some((u) => u.toLowerCase() === e.unit.toLowerCase()))
          .map((e) => ({ id: e.id, key: e.key, unit: e.unit, kind: e.kind, state: e.state, labels: e.labels, author: e.author, draft: e.pull?.draft ?? false, createdAt: e.createdAt })),
        errors: [],
      };
    } else if (args.method === "sourceSearchIssues") {
      const units = input.units as string[];
      const query = String(input.query);
      out = searchUnsupported
        ? { issues: [], unsupported: true, errors: [] }
        : searchError !== null
          ? { issues: [], unsupported: false, errors: [searchError] }
          : {
              issues: [...entities.values()]
                .filter((e) => SOURCE_PLUGIN_IDS[e.source] === args.pluginId && units.some((u) => u.toLowerCase() === e.unit.toLowerCase()))
                .filter((e) => (e.description ?? "").includes(query) || (e.title ?? "").includes(query))
                .map((e) => ({ id: e.id, key: e.key, title: e.title, description: e.description, state: e.state, stateType: e.stateType, unit: e.unit, assignee: e.assignees[0] ?? null })),
              unsupported: false,
              errors: [],
            };
    } else if (args.method === "sourceValidate") {
      // The real plugins validate the input; an empty label was once accepted here and rejected there.
      sourceContract.sourceValidate.input.parse(input);
      const source = args.pluginId === SOURCE_PLUGIN_IDS.github ? "github" : "linear";
      const viewer = source in viewers ? viewers[source]! : "Jane";
      out = {
        viewer,
        units: (input.units as string[]).map((unit) => {
          const label = String(input.label).toLowerCase();
          const absent = (missingLabels.get(`${source}:${unit.toLowerCase()}`) ?? []).some((l) => l.toLowerCase() === label);
          return { unit, found: true, labelFound: !absent, missingStates: missingStates.get(`${source}:${unit.toLowerCase()}`) ?? [] };
        }),
        mine: args.pluginId === SOURCE_PLUGIN_IDS.github ? [] : linearMine,
        error: null,
      };
    } else if (args.method === "sourceEnsureLabel") {
      // The real plugins validate the input and create idempotently; the fake
      // remembers what it created so a second run is `existed` (BB-236).
      sourceContract.sourceEnsureLabel.input.parse(input);
      if (labelEnsureUnavailable) throw Object.assign(new Error("Unknown RPC method: sourceEnsureLabel"), { code: "unknown_method" });
      if (labelEnsureThrow !== null) throw new Error(labelEnsureThrow);
      const source = args.pluginId === SOURCE_PLUGIN_IDS.github ? "github" : "linear";
      const units = input.units as string[];
      labelEnsureCalls.push({ source, units, label: String(input.label) });
      out = {
        results: units.map((unit) => {
          const key = `${source}:${unit.toLowerCase()}`;
          const ensuredKey = `${key}:${String(input.label).toLowerCase()}`;
          const failure = labelEnsureFailures.get(key);
          if (failure !== undefined) return { unit, status: "error", error: failure };
          if (labelsEnsured.has(ensuredKey)) return { unit, status: "existed", error: null };
          labelsEnsured.add(ensuredKey);
          return { unit, status: "created", error: null };
        }),
      };
    }
    else if (args.method === "sourceDependabotAlerts") {
      const units = input.units as string[];
      out = { viewer: "jane", alerts: units.flatMap((u) => dependabotAlerts.get(u.toLowerCase()) ?? []), errors: [], graphEmpty: units.filter((u) => dependabotGraphEmpty.has(u.toLowerCase())) };
    }
    else if (args.method === "sourceDeployments") {
      const key = `${String(input.repo).toLowerCase()} ${String(input.environment).toLowerCase()}`;
      out = { deployments: sourceDeployments.get(key) ?? [], error: null };
    }
    else if (args.method === "sourceFileAtRef") {
      out = { content: sourceFiles.get(`${String(input.repo).toLowerCase()} ${String(input.path)} ${String(input.ref)}`) ?? null, error: null };
    }
    else if (args.method === "sourceLatestCommit") {
      out = { sha: sourceCommits.get(`${String(input.repo).toLowerCase()} ${String(input.path)} ${String(input.until)}`) ?? null, committedAt: null, error: null };
    }
    else if (args.method === "sourceWorkflowRun") {
      const key = input.runId === undefined ? `${String(input.repo).toLowerCase()} ${String(input.workflow)} ${String(input.runNumber)}` : `${String(input.repo).toLowerCase()} ${String(input.runId)}`;
      out = { run: sourceRuns.get(key) ?? null, error: null };
    }
    else if (args.method === "sourceCompare") {
      out = { status: sourceCompares.get(`${String(input.repo).toLowerCase()} ${String(input.base)} ${String(input.head)}`) ?? null, error: null };
    }
    else if (args.pluginId === "voice-transcription" && args.method === "realtime.open") {
      if (voiceRealtimeRefusal !== null) throw new Error(voiceRealtimeRefusal);
      const sessionId = `sess_${++realtimeSessionSeq}`;
      realtimeOpens.push({ input, sessionId });
      out = { sessionId, maxDurationMs: 1_200_000 };
    }
    else throw Object.assign(new Error(`unknown ${args.pluginId}.${args.method}`), { status: 404 });
    return args.outputSchema.parse(out);
  };

  const sdk = {
    plugins: {
      callRpc,
      // BB-300: the stand-up reads the voice plugin's non-secret settings for the
      // endpoint, and its AI-service status for the key.
      getSettings: async (args: { pluginId: string }) => {
        if (voiceSettingsThrow !== null) throw new Error(voiceSettingsThrow);
        if (args.pluginId !== "voice-transcription") throw new Error(`no plugin ${args.pluginId}`);
        return {
          ok: true,
          schema: { baseUrl: { type: "string", label: "Endpoint base URL", default: "https://api.openai.com/v1" }, apiKey: { type: "string", label: "API key", secret: true } },
          values: { baseUrl: voiceBaseUrl },
        };
      },
    },
    projects: {
      list: async () => projectList.map((p) => ({ ...p })),
      // A checkout on a machine that is off (the default source) and one on a machine that is on.
      get: async () => ({
        id: "p1",
        name: "Acme",
        sources: [
          { id: "src_off", projectId: "p1", type: "local_path", hostId: "host_off", path: "/p/.bb", isDefault: true },
          { id: "src_on", projectId: "p1", type: "local_path", hostId: "host_on", path: "/p/.bb", isDefault: false },
        ],
      }),
    },
    files: {
      mkdir: async () => ({}),
      write: async (args: { path: string; hostId?: string; content?: string; expectedSha256?: string | null }) => {
        writes.push({ path: args.path, hostId: args.hostId });
        // `expectedSha256: null` is the never-overwrite guard: a file already there is kept.
        const existed = writtenContent.has(args.path);
        if (existed && args.expectedSha256 === null) return { outcome: "kept existing" };
        writtenContent.set(args.path, args.content ?? "");
        return { outcome: "written" };
      },
      read: async (args: { path: string; hostId?: string }) => {
        const key = fileKey(args.hostId, args.path);
        if (!fileContents.has(key)) throw Object.assign(new Error("no such file"), { status: 404 });
        const content = fileContents.get(key)!;
        return { path: args.path, content, contentEncoding: "utf8" as const, sizeBytes: content.length, sha256: "sha" };
      },
      remove: async (args: { path: string; hostId?: string }) => {
        fileContents.delete(fileKey(args.hostId, args.path));
        return {};
      },
    },
    hosts: { list: async () => [{ id: "host_off", status: "disconnected" }, { id: "host_on", status: "connected" }] },
    threadSections: {
      list: async () => sections.map((s) => ({ ...s })),
      create: async ({ name }: { name: string }) => {
        const section = { id: `sec_${sections.length + 1}`, name };
        sections.push(section);
        return { ...section };
      },
      delete: async ({ id }: { id: string }) => {
        sections.splice(sections.findIndex((s) => s.id === id), 1);
        for (const t of threads.values()) if (t.sectionId === id) t.sectionId = null;
        return {};
      },
    },
    threads: {
      spawn: async (args: Record<string, unknown>) => {
        if (spawnError !== null) throw new Error(spawnError);
        if (spawnDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, spawnDelayMs));
        const id = `thr_${++n}`;
        const environment = args.environment as { machine?: { hostId?: string }; environmentProviderId?: string } | undefined;
        threads.set(id, {
          status: "idle",
          archivedAt: null,
          visibility: "visible",
          title: (args.title as string | undefined) ?? null,
          sectionId: (args.sectionId as string | undefined) ?? null,
          ...(args.parentThreadId === undefined ? {} : { parentThreadId: args.parentThreadId as string }),
          ...(args.parentNotifications === undefined ? {} : { parentNotifications: args.parentNotifications as string }),
          ...(environment?.machine?.hostId === undefined ? {} : { hostId: environment.machine.hostId }),
          ...(args.providerId === undefined ? {} : { providerId: args.providerId as string }),
          ...(args.model === undefined ? {} : { model: args.model as string }),
          ...(args.reasoningLevel === undefined ? {} : { reasoningLevel: args.reasoningLevel as string }),
          ...(environment?.environmentProviderId === undefined ? {} : { environmentProviderId: environment.environmentProviderId }),
        });
        metadata.set(id, { ...((args.pluginMetadata as Record<string, unknown> | undefined) ?? {}) });
        spawns.push({ ...args, id });
        return makeThreadResponse({ id });
      },
      send: async (args: { threadId: string; input: Array<{ text: string }> }) => {
        const t = threads.get(args.threadId);
        if (t?.sendError !== undefined) throw Object.assign(new Error(t.sendError.message), { code: t.sendError.code, status: t.sendError.status });
        sends.push({ threadId: args.threadId, text: args.input.map((i) => i.text).join(""), at: now });
        return {};
      },
      retry: async (args: { threadId: string; turnRequestId: string; sendAt?: number; reason?: string }) => {
        if (retryConflict) throw Object.assign(new Error("retry already queued"), { code: "retry_already_queued", status: 409 });
        retries.push({ ...args });
        const attempt = retries.filter((r) => r.threadId === args.threadId).length + 1;
        const turnRequestId = `retry_${retries.length}`;
        // Core's `retryOfRequestId` is the chain's original, not the immediate
        // parent, so a retry of a retry still names the original.
        const root = retryEvents.find((e) => e.threadId === args.threadId && e.requestId === args.turnRequestId)?.retryOfRequestId ?? args.turnRequestId;
        retryEvents.push({ threadId: args.threadId, requestId: turnRequestId, retryOfRequestId: root });
        if (retryQueued) return { ok: true as const, delivery: "queued" as const, attempt, turnRequestId, queuedMessageId: `q_${retries.length}`, sendAt: args.sendAt ?? null, waitingOn: { kind: "time" as const } };
        return { ok: true as const, delivery: "sent" as const, attempt, turnRequestId };
      },
      queuedMessages: {
        delete: async (args: { threadId: string; queuedMessageId: string }) => {
          queuedDeletes.push({ ...args });
          return {};
        },
      },
      get: async ({ threadId }: { threadId: string }) => {
        const t = threads.get(threadId);
        if (t === undefined) throw Object.assign(new Error("not found"), { status: 404 });
        return {
          ...makeThreadResponse({ id: threadId, title: t.title ?? null, status: t.status as never, archivedAt: t.archivedAt, visibility: (t.visibility ?? "visible") as never, projectId: t.projectId ?? "p1", environmentId: "env1", providerId: t.providerId ?? "claude-code", parentThreadId: t.parentThreadId ?? null, parentNotifications: (t.parentNotifications ?? "auto") as never, sectionId: t.sectionId ?? null }),
          ...(t.hostId === undefined && t.environmentProviderId === undefined && t.environmentStatus === undefined && t.environmentPhase === undefined ? {} : { environment: { hostId: t.hostId ?? null, environmentProviderId: t.environmentProviderId ?? null, branchName: t.branchName ?? null, status: t.environmentStatus ?? "ready", lifecycle: { phase: t.environmentPhase ?? "active" } } }),
        };
      },
      // What the server answers: the thread's own execution once a turn ran, and before that the
      // project's remembered picker defaults, which a spawn with other flags does not change.
      // The plugin must not read a pending worker's model from here.
      defaultExecutionOptions: async ({ threadId }: { threadId: string }) => {
        const t = threads.get(threadId);
        if (t === undefined) return null;
        if (t.model === undefined) return { model: "claude-fable-5-1", reasoningLevel: "medium", serviceTier: "default", permissionMode: "auto", source: "client/turn/requested" };
        return { model: t.model, reasoningLevel: t.reasoningLevel ?? "none", serviceTier: "default", permissionMode: "auto", source: "client/turn/requested" };
      },
      list: async ({ sectionId, archived, parentThreadId, projectId, hasParent }: { sectionId?: string; archived?: boolean; parentThreadId?: string; projectId?: string; hasParent?: boolean }) =>
        [...threads.entries()]
          .filter(
            ([, t]) =>
              (sectionId === undefined || t.sectionId === sectionId) &&
              (archived !== false || t.archivedAt === null) &&
              (parentThreadId === undefined || (t.parentThreadId ?? null) === parentThreadId) &&
              (projectId === undefined || (t.projectId ?? "p1") === projectId) &&
              (hasParent === undefined || ((t.parentThreadId ?? null) !== null) === hasParent),
          )
          .map(([id, t]) => makeThreadResponse({ id, status: t.status as never, archivedAt: t.archivedAt, parentThreadId: t.parentThreadId ?? null, lifecycleOwnerThreadId: t.lifecycleOwnerThreadId ?? null, sectionId: t.sectionId ?? null })),
      experimental_listDescendants: async ({ threadIds, includeArchived, includeHidden }: { threadIds: string[]; includeArchived?: boolean; includeHidden?: boolean }) => {
        const descendants = (id: string): string[] => {
          const out: string[] = [];
          for (const [childId, child] of threads) {
            if ((child.parentThreadId ?? null) !== id) continue;
            if (includeArchived !== true && child.archivedAt !== null) continue;
            if (includeHidden !== true && child.visibility === "hidden") continue;
            out.push(childId, ...descendants(childId));
          }
          return out;
        };
        return { threads: threadIds.map((threadId) => ({ threadId, descendantIds: descendants(threadId) })) };
      },
      archive: async ({ threadId }: { threadId: string }) => {
        threads.get(threadId)!.archivedAt = 1;
        return {};
      },
      unarchive: async ({ threadId }: { threadId: string }) => {
        threads.get(threadId)!.archivedAt = null;
        return {};
      },
      stop: async () => ({}),
      update: async (args: { threadId: string; title?: string; parentThreadId?: string | null; parentNotifications?: string; sectionId?: string | null; visibility?: string }) => {
        const t = threads.get(args.threadId);
        if (t !== undefined && args.sectionId !== undefined) t.sectionId = args.sectionId;
        if (t !== undefined && args.title !== undefined) t.title = args.title;
        if (t !== undefined && args.parentThreadId !== undefined) t.parentThreadId = args.parentThreadId;
        if (t !== undefined && args.parentNotifications !== undefined) t.parentNotifications = args.parentNotifications;
        if (t !== undefined && args.visibility !== undefined) t.visibility = args.visibility;
        return {};
      },
      delete: async ({ threadId }: { threadId: string }) => {
        deletes.push(threadId);
        return {};
      },
      markRead: async ({ threadId }: { threadId: string }) => ({ threadId, readAt: now, unreadCount: 0 }),
      compact: async () => ({ ok: true }),
      storageLocation: async ({ threadId }: { threadId: string }) => ({ hostId: "host_on", storageRootPath: `/storage/${threadId}` }),
      updatePluginMetadata: async (args: { threadId: string; set?: Record<string, unknown> }) => {
        const next = { ...(metadata.get(args.threadId) ?? {}), ...(args.set ?? {}) };
        metadata.set(args.threadId, next);
        return next;
      },
      getPluginMetadata: async (args: { threadId: string }) => ({ ...(metadata.get(args.threadId) ?? {}) }),
      experimental_listPluginMetadata: async (args: { threadIds: string[] }) => ({ threads: args.threadIds.filter((id) => metadata.has(id)).map((threadId) => ({ threadId, metadata: { ...(metadata.get(threadId) ?? {}) } })) }),
      events: {
        list: async ({ threadId, types, order }: { threadId: string; types?: string[]; order?: string }) => {
          if (types?.includes("thread/contextWindowUsage/updated")) return usage.has(threadId) ? [{ id: "u", seq: 1, threadId, createdAt: now, scope: "thread", type: "thread/contextWindowUsage/updated", data: { contextWindowUsage: { usedTokens: usage.get(threadId), modelContextWindow: 1_000_000, estimated: true } } }] : [];
          if (!types?.includes("client/turn/requested")) return [];
          const rows = [
            // The spawn's execution as the server resolved it; absent while the thread is still pending its first turn.
            ...(threads.get(threadId)?.model === undefined
              ? []
              : [{ id: "t", seq: 1, threadId, createdAt: now, scope: "thread", type: "client/turn/requested", data: { execution: { model: threads.get(threadId)!.model, reasoningLevel: threads.get(threadId)!.reasoningLevel ?? "none", permissionMode: "auto", serviceTier: "default", source: "client/turn/requested" } } }]),
            // A spawn's prompt is the thread's first turn, recorded as the
            // user's by bb, so it is a plugin send too (BB-178).
            ...spawns.filter((s) => s.id === threadId && typeof s.prompt === "string").map((s, i) => ({ id: `p${i}`, seq: i, threadId, createdAt: now, scope: "thread", type: "client/turn/requested", data: { initiator: "user", senderThreadId: null, originPluginId: "stewards", input: [{ type: "text", text: s.prompt as string }] } })),
            // The plugin's own sends are turns too: bb records them with
            // `initiator: "user"` and no sender thread, so the text is the
            // only thing telling them from the owner's (BB-178).
            ...sends.filter((s) => s.threadId === threadId).map((s, i) => ({ id: `s${i}`, seq: i, threadId, createdAt: s.at ?? now, scope: "thread", type: "client/turn/requested", data: { initiator: "user", senderThreadId: null, originPluginId: "stewards", input: [{ type: "text", text: s.text }] } })),
            ...userTurns.filter((t) => t.threadId === threadId).map((t, i) => ({ id: `e${i}`, seq: i, threadId, createdAt: t.at ?? now, scope: "thread", type: "client/turn/requested", data: { initiator: "user", senderThreadId: null, originPluginId: null, input: [{ type: "text", text: t.text }] } })),
            ...retryEvents.filter((r) => r.threadId === threadId).map((r, i) => ({ id: `r${i}`, seq: i, threadId, createdAt: now, scope: "thread", type: "client/turn/requested", data: { initiator: "user", senderThreadId: null, originPluginId: null, requestId: r.requestId, retryOfRequestId: r.retryOfRequestId, input: [] } })),
          ];
          return order === "desc" ? [...rows].reverse() : rows;
        },
      },
    },
    system: {
      // BB-300: the voice service's readiness for the stand-up button.
      aiServices: async () => ({
        selections: {},
        services: voiceServicePresent
          ? [
              {
                automaticRank: null,
                displayName: "OpenAI-compatible",
                id: "openai-compatible",
                pluginId: "voice-transcription",
                status: voiceServiceReady ? { ready: true } : { ready: false, message: voiceServiceMessage },
                tasks: ["voice"],
              },
            ]
          : [],
      }),
      uiPreferences: {
        list: async () => ({ preferences: Object.fromEntries([...uiPreferences].map(([key, entry]) => [key, { ...entry }])) }),
        set: async (args: { key: string; value: unknown; expectedRevision: number }) => {
          const current = uiPreferences.get(args.key);
          if (current !== undefined && current.revision !== args.expectedRevision) throw Object.assign(new Error(`revision conflict for ${args.key}`), { status: 409 });
          const next = { value: args.value, revision: (current?.revision ?? 0) + 1 };
          uiPreferences.set(args.key, next);
          uiPreferencesWrites.push({ ...args });
          return { key: args.key, ...next };
        },
      },
    },
  };
  let now = Date.parse("2026-10-14T15:00:00Z");
  return { files, writes, writtenContent, fileContents, repos, primary, entities, projectList, dependabotAlerts, dependabotGraphEmpty, sourceDeployments, sourceFiles, sourceCommits, sourceRuns, sourceCompares, labelEnsureCalls, labelsEnsured, labelEnsureFailures, setLabelEnsureUnavailable: (value: boolean) => { labelEnsureUnavailable = value; }, setPushUnavailable: (value: boolean) => { pushUnavailable = value; }, setLabelEnsureThrow: (value: string | null) => { labelEnsureThrow = value; }, setLayout: (value: "primary" | "directory") => { layout = value; primary = value === "directory" ? null : { dir: "bb", url: "https://github.com/acme/bb.git" }; }, viewers, setLinearMine: (teams: Array<{ unit: string; name: string }>) => { linearMine = teams; }, setMissingStates: (source: "linear" | "github", unit: string, states: string[]) => { missingStates.set(`${source}:${unit.toLowerCase()}`, states); }, setMissingLabel: (source: "linear" | "github", unit: string, labels: string[]) => { missingLabels.set(`${source}:${unit.toLowerCase()}`, labels); }, rpcCalls, githubTrees, githubBranchProtection, githubLabels, setSnapshotError: (id: string, fail: boolean) => { if (fail) snapshotErrors.add(id); else snapshotErrors.delete(id); }, setSearchUnsupported: (value: boolean) => { searchUnsupported = value; }, setSearchError: (value: string | null) => { searchError = value; }, setCreatePullError: (value: string | null) => { createPullError = value; }, setMergePullError: (value: string | null) => { mergePullError = value; }, setSpawnError: (value: string | null) => { spawnError = value; }, setSpawnDelayMs: (value: number) => { spawnDelayMs = value; }, setMoveHeadOnMerge: (value: boolean) => { moveHeadOnMerge = value; }, setPullDetailsError: (value: string | null) => { pullDetailsError = value; }, setRetryConflict: (value: boolean) => { retryConflict = value; }, setRetryQueued: (value: boolean) => { retryQueued = value; }, threads, deletes, sections, usage, metadata, spawns, sends, retries, retryEvents, queuedDeletes, userTurns, githubComments, githubReviews, githubMerges, githubPulls, githubClosedPulls, githubDefaultBranches, githubBranches, githubFiles, githubFileContents, githubDispatches, setMergeDispatchError: (value: string | null) => { mergeDispatchError = value; }, github, sdk, uiPreferences, uiPreferencesWrites, realtimeOpens, setVoiceBaseUrl: (value: string) => { voiceBaseUrl = value; }, setVoiceServicePresent: (value: boolean) => { voiceServicePresent = value; }, setVoiceServiceReady: (value: boolean, message?: string) => { voiceServiceReady = value; if (message !== undefined) voiceServiceMessage = message; }, setVoiceSettingsThrow: (value: string | null) => { voiceSettingsThrow = value; }, setVoiceRealtimeRefusal: (value: string | null) => { voiceRealtimeRefusal = value; }, now: () => now, advance: (ms: number) => (now += ms) };
}

export async function setup(extra: Partial<StewardsDeps> = {}, settings: Record<string, string> = {}, seedProvider?: string | null | "fail-list" | "fail-set", seedNavigation?: string | null | "fail-list" | "fail-set") {
  const w = world();
  if (seedProvider === null) w.uiPreferences.delete("sidebar.threadListProvider");
  else if (seedProvider !== undefined && seedProvider !== "fail-list" && seedProvider !== "fail-set") w.uiPreferences.set("sidebar.threadListProvider", { value: seedProvider, revision: 4 });
  if (seedNavigation === null) w.uiPreferences.delete("sidebar.navigationProvider");
  else if (seedNavigation !== undefined && seedNavigation !== "fail-list" && seedNavigation !== "fail-set") w.uiPreferences.set("sidebar.navigationProvider", { value: seedNavigation, revision: 4 });
  if (seedProvider === "fail-list" || seedNavigation === "fail-list") w.sdk.system.uiPreferences.list = async () => {
    throw new Error("the preferences store is down");
  };
  if (seedProvider === "fail-set" || seedNavigation === "fail-set") w.sdk.system.uiPreferences.set = async () => {
    throw new Error("the preferences store is down");
  };
  const { bb, harness } = createFakePluginHost({ pluginId: "stewards", sdk: w.sdk as never, agentSkillIds: ["stewards", "onboarding"], settings });
  await createStewardsPlugin({ now: w.now, timing: { debounceMs: 1, nightlyStaggerMs: 0 }, github: w.github, ...extra })(bb);
  const hooks = testHooks.get("stewards")!;
  // The local per-project switch is off by default; tests that are not about
  // the switch itself run with p1 switched on, as a project whose owner did.
  await hooks.setProjectEnabled("p1", true);
  /** Let debounced work run to completion. */
  const flush = async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await hooks.settle();
    }
  };
  const ring = async (source: "linear" | "github", id: string) => {
    await harness.callRpc("stewardsRing", { source, id }, { experimental_caller: { kind: "plugin", pluginId: SOURCE_PLUGIN_IDS[source] } });
    await flush();
  };
  const tool = async (name: string, args: Record<string, unknown>, threadId: string) => {
    // The steward-filed decide, configure and provide-secret needs are
    // escalations now, so the tests' old `needs` calls are split into the
    // escalation path here rather than rewritten at every call site.
    if (name === "steward_report" && Array.isArray(args.needs)) {
      const stewardKinds = new Set(["decide", "configure", "provide-secret"]);
      const needs = args.needs as Array<Record<string, unknown>>;
      const split = needs.filter((n) => stewardKinds.has(String(n.kind)));
      if (split.length > 0) {
        const key = typeof args.binding === "string" ? args.binding : "ENG-12";
        for (const n of split) {
          if (n.kind === "provide-secret") {
            if (n.variable === undefined && n.setting === undefined) return { text: `provide-secret for ${String(n.what)} not filed: name the env var with \`variable\`, or a stewards secret setting with \`setting\`.`, error: false };
            if (n.setting !== undefined && !SECRET_SETTING_NAMES.has(String(n.setting))) return { text: `provide-secret for ${String(n.variable ?? n.what)} not filed: ${JSON.stringify(n.setting)} is not a secret setting of the stewards plugin.`, error: false };
          }
          if (n.choices !== undefined) {
            if (n.kind !== "decide") return { text: `${String(n.kind)} for ${String(n.url ?? "the item")} not filed: choices are for a decide item.`, error: false };
            const choices = n.choices as string[];
            if (choices.length < 2) throw new Error("expected array to have >=2 items");
            if (choices.length > 6) throw new Error("expected array to have <=6 items");
          }
          escalationNeed({
            key,
            kind: n.kind as "decide" | "configure" | "provide-secret",
            what: String(n.what),
            ...(n.url === undefined ? {} : { url: String(n.url) }),
            ...(n.how === undefined ? {} : { how: String(n.how) }),
            ...(n.variable === undefined ? {} : { variable: String(n.variable) }),
            ...(n.purpose === undefined ? {} : { purpose: String(n.purpose) }),
            ...(n.worker === undefined ? {} : { worker: String(n.worker) }),
            ...(n.writeEnv === undefined ? {} : { writeEnv: String(n.writeEnv) }),
            ...(n.setting === undefined ? {} : { setting: String(n.setting) }),
            ...(n.page === undefined ? {} : { page: String(n.page) }),
            ...(n.choices === undefined ? {} : { choices: n.choices as string[] }),
          });
        }
        args = { ...args, needs: needs.filter((n) => !stewardKinds.has(String(n.kind))) };
      }
    }
    // `ask` and a user-bound `forward` require a resolution; the tests predate
    // that and default to text here. A test for the requirement passes none.
    if (name === "steward_update") {
      if (args.ask !== undefined && typeof args.ask === "object" && (args.ask as Record<string, unknown>).resolution === undefined) {
        args = { ...args, ask: { ...(args.ask as Record<string, unknown>), resolution: "text" } };
      }
      if (args.forward !== undefined && args.resolution === undefined) args = { ...args, resolution: "text" };
    }
    const r = (await harness.behavior.callAgentTool(name, args, { threadId, projectId: "p1" })) as string | { content: Array<{ text?: string }>; isError?: boolean };
    return typeof r === "string" ? { text: r, error: false } : { text: r.content.map((c) => c.text ?? "").join(""), error: r.isError === true };
  };
  const list = async () => ((await harness.callRpc("stewardsList", { projectId: "p1", all: true })) as { bindings: Array<{ key: string; kind: string; threadId: string | null; ended: boolean; escalations: number; needs: number; summary: string | null }> }).bindings;
  const idle = async (threadId: string, lastAssistantText: string | null = null) => {
    const t = w.threads.get(threadId);
    if (t !== undefined) t.status = "idle";
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId }), lastAssistantText });
    await flush();
  };
  /** A thread a steward started with `bb thread spawn --parent-self` or `--lifecycle-owner-thread`. */
  const created = async (
    id: string,
    parent: string,
    title = "Implement",
    over: { providerId?: string; model?: string | null; reasoningLevel?: string | null; environmentProviderId?: string | null; sectionId?: string | null; branchName?: string | null; lifecycleOwnerThreadId?: string | null } = {},
  ) => {
    const providerId = over.providerId ?? "claude-code";
    const model = over.model === undefined ? "claude-opus-5-5" : over.model;
    const reasoningLevel = over.reasoningLevel === undefined ? "high" : over.reasoningLevel;
    const environmentProviderId = over.environmentProviderId === undefined ? "multi-repo-workspace" : over.environmentProviderId;
    // The worker's workspace branch; the pull() fixture's head names ENG-12
    // (BB-239), so a worker owns it unless a test says otherwise (BB-52 rule 0).
    const branchName = over.branchName === undefined ? "bb/eng-12-retry" : over.branchName;
    const lifecycleOwner = over.lifecycleOwnerThreadId === undefined ? parent : over.lifecycleOwnerThreadId;
    w.threads.set(id, { status: "active", archivedAt: null, visibility: "visible", parentThreadId: parent, lifecycleOwnerThreadId: lifecycleOwner, sectionId: over.sectionId ?? null, providerId, ...(model === null ? {} : { model }), ...(reasoningLevel === null ? {} : { reasoningLevel }), environmentProviderId, branchName });
    await harness.behavior.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id, parentThreadId: parent, lifecycleOwnerThreadId: lifecycleOwner, title, originPluginId: null, providerId, sectionId: over.sectionId ?? null }) });
    await flush();
  };
  /** A top-level worker a steward started with only `--lifecycle-owner-thread`: no parent. */
  const createdOwned = async (id: string, owner: string, title = "Implement", sectionId: string | null = null) => {
    w.threads.set(id, { status: "active", archivedAt: null, visibility: "visible", parentThreadId: null, lifecycleOwnerThreadId: owner, sectionId, providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", environmentProviderId: "multi-repo-workspace", branchName: "bb/eng-12-retry" });
    await harness.behavior.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id, parentThreadId: null, lifecycleOwnerThreadId: owner, title, originPluginId: null, providerId: "claude-code", sectionId }) });
    await flush();
  };
  /** A reviewer a worker started without `--parent-self` (BB-323): no parent, the worker as lifecycle owner. */
  const createdReviewer = async (
    id: string,
    worker: string,
    title = "Review",
    over: { providerId?: string; model?: string | null; reasoningLevel?: string | null; environmentProviderId?: string | null } = {},
  ) => {
    const providerId = over.providerId ?? "claude-code";
    const model = over.model === undefined ? "claude-opus-5-5" : over.model;
    const reasoningLevel = over.reasoningLevel === undefined ? "high" : over.reasoningLevel;
    const environmentProviderId = over.environmentProviderId === undefined ? "multi-repo-workspace" : over.environmentProviderId;
    w.threads.set(id, { status: "active", archivedAt: null, visibility: "hidden", parentThreadId: null, lifecycleOwnerThreadId: worker, providerId, ...(model === null ? {} : { model }), ...(reasoningLevel === null ? {} : { reasoningLevel }), environmentProviderId, branchName: "bb/eng-12-retry" });
    await harness.behavior.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id, parentThreadId: null, lifecycleOwnerThreadId: worker, title, originPluginId: null, providerId, sectionId: null }) });
    await flush();
  };
  /** A steward-filed escalation the project steward has forwarded to the user, for tests. */
  const escalationNeed = (fields: { key?: string; kind: "decide" | "configure" | "provide-secret"; url?: string; what: string; how?: string; variable?: string; purpose?: string; worker?: string; writeEnv?: string; setting?: string; page?: string; choices?: string[] }) => {
    const bindingId = hooks.store.find(fields.key ?? "ENG-12", "p1")!.id;
    const resolutionKind = fields.kind === "provide-secret" ? "secret" : fields.kind === "configure" ? "done" : (fields.choices ?? []).length > 0 ? "choice" : "text";
    return hooks.store.escalate({
      bindingId,
      kind: "decision",
      question: fields.what,
      meanwhile: "Wait.",
      route: "user",
      recommendation: null,
      projectId: "p1",
      resolutionKind,
      url: fields.url ?? null,
      choices: fields.choices,
      data: {
        ...(fields.variable === undefined ? {} : { variable: fields.variable }),
        ...(fields.purpose === undefined ? {} : { purpose: fields.purpose }),
        ...(fields.worker === undefined ? {} : { workerThreadId: fields.worker }),
        ...(fields.writeEnv === undefined ? {} : { writeEnv: fields.writeEnv }),
        ...(fields.setting === undefined ? {} : { setting: fields.setting }),
        ...(fields.page === undefined ? {} : { page: fields.page }),
        ...(fields.choices === undefined ? {} : { choices: fields.choices }),
      },
    });
  };
  return { ...w, bb, harness, hooks, flush, ring, tool, list, idle, created, createdOwned, createdReviewer, escalationNeed };
}
