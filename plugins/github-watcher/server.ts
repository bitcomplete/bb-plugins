// GitHub: let a thread watch a pull request or issue and be woken when it
// changes, as the developer.
//
// There is no connect step of its own. Team setup signs `gh` in on this
// server host, bb core forwards that login to every machine, and this
// plugin reads the same token with `gh auth token` whenever it needs one:
// to read the target as the developer, and to prove each watch to
// the hooks service. A thread sees results, never the token.
//
// Everything else a thread wants from GitHub it does with `gh` on its
// machine. What `gh` cannot do is wake a thread later, and that is the heart
// of this plugin: a watch (watch.ts) is a row in the plugin's SQLite plus a
// lease on the hooks service (hooks-client.ts); when GitHub's webhook rings, the
// target is re-read here and the thread is messaged with what changed.
//
// The stewards plugin (../stewards/DESIGN.md) reads GitHub through this
// plugin's half of source-contract.ts, and hears about its repositories and
// bound pull requests through the same doorbell stream, rung over to it as
// `stewardsRing`.
import { cliCommand, defineCli, defineRpcContract, type BbPluginApi, type JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { WATCHES_CHANGED } from "./channels.js";
import { createGhTokenReader, type TokenReader } from "./gh.js";
import {
  BACKLOG_ISSUES_QUERY,
  DEPENDENCY_GRAPH_QUERY,
  FILE_AT_REF_QUERY,
  GITHUB_API_URL,
  GitHubRequestError,
  LATEST_COMMIT_QUERY,
  OPEN_ISSUES_QUERY,
  OPEN_PULLS_QUERY,
  REPO_CHECK_QUERY,
  SEARCH_ISSUES_QUERY,
  TARGET_QUERY,
  TARGET_QUERY_BASE,
  VIEWER_QUERY,
  comparePath,
  dependabotAlertsPath,
  deploymentStatusesPath,
  deploymentsPath,
  graphql,
  issuesPath,
  kindName,
  labelAlreadyExists,
  labelPath,
  parseBacklogIssues,
  parseCompare,
  parseCreatedComment,
  parseCreatedIssue,
  parseDefaultBranch,
  parseDependabotAlerts,
  parseDependencyGraphCount,
  parseDeploymentStatus,
  parseDeployments,
  parseFileAtRef,
  parseLatestCommit,
  parseMergeBaseIsDefaultTip,
  parseOpenIssues,
  parseOpenPulls,
  parsePulls,
  parseRef,
  parseRefKey,
  parseRepo,
  parseRepoCheck,
  parseSearchIssues,
  parseSnapshot,
  parseTarget,
  parseViewer,
  parseWorkflowJobs,
  parseWorkflowRuns,
  pullsPath,
  refKey,
  subIssuesPath,
  workflowRunJobsPath,
  workflowRunPath,
  workflowRunsPath,
  type Target,
} from "./github.js";
import { createHooksLoop, HOOKS_URL_ENV, type Lease, type Rejection } from "./hooks-client.js";
import { createPoller, DEFAULT_POLL_TIMING, RateLimitError, type PollResult, type Poller, type PollerTiming } from "./poller.js";
import { deploymentSchema, ringStewards, signedBy, sourceContract, STEWARDS_PLUGIN_ID, workflowRunSchema, type AdoptableEntity, type BacklogIssue, type Deployment, type EntitySnapshot, type SearchIssue, type WorkflowRun } from "./source-contract.js";
import { buildUsage, createRefusals, formatUsage, usageViewSchema, type InterestView } from "./usage.js";
import { compare, createCheckQueue, createWatchStore, initialCursors, initialNoChecks, NO_CHECKS_GRACE_MS, snapshotOf, WATCH_MIGRATIONS, type WatchRow } from "./watch.js";

export { WATCHES_CHANGED };

const REQUEST_TIMEOUT_MS = 30_000;

export const rpcContract = defineRpcContract({
  /** Every watch on this server and what the doorbell stream is doing. */
  watches: {
    input: z.null(),
    output: usageViewSchema,
  },
  /** Forget one watch; the thread is not told. */
  unwatch: {
    input: z.object({ threadId: z.string().min(1), targetId: z.string().min(1) }),
    output: z.object({ removed: z.boolean() }),
  },
  // What stewards reads GitHub through: sourceSnapshot, sourceValidate,
  // sourceAdoptable and sourceSetInterest (source-contract.ts).
  ...sourceContract,
});

/** Where the units and entities stewards wants to hear about are kept, so a restart keeps leasing them. */
export const INTEREST_KEY = "stewards/interest";
/** Where the poller keeps the last fingerprint it saw per interest entity, so an unchanged one is not rung again. */
export const INTEREST_CURSORS_KEY = "stewards/interest-cursors";
const interestSchema = z.object({ units: z.array(z.string()), entities: z.array(z.string()), dependabot: z.array(z.string()).default([]), deployment: z.array(z.string()).default([]) });
type Interest = z.infer<typeof interestSchema>;

/** How long a token read from gh is reused before gh is asked again. */
export const TOKEN_CACHE_MS = 5 * 60 * 1000;

/**
 * The poller gives up a round once GitHub's remaining quota is at or below
 * this and backs off until the reset: a read that would otherwise be refused
 * is worth waiting for, and the reset is the server's own clock.
 */
export const RATE_LIMIT_FLOOR = 10;

/** How many deployments one poll reads the status of per repository, newest first. */
export const DEPLOYMENTS_PER_POLL = 20;

/** One page of a repository's open backlog, and the most one `sourceBacklog` call returns in all (BB-396). */
const BACKLOG_PAGE = 100;
const BACKLOG_MAX = 1000;

/** How many entity cursors the poller remembers before it drops the oldest. */
export const INTEREST_CURSOR_MAX = 5000;

export interface GitHubPluginDeps {
  fetch: typeof fetch;
  now: () => number;
  env: Record<string, string | undefined>;
  /** The developer's token, from gh on this host. */
  token: TokenReader;
  /** Where GraphQL is sent; GITHUB_API_URL unless a test says otherwise. */
  apiUrl?: string;
  /** The polling timer's intervals; the defaults unless a test says otherwise. */
  pollTiming?: Partial<PollerTiming>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const refInput = z
  .string()
  .trim()
  .min(1)
  .describe("The pull request or issue: its URL (https://github.com/owner/repo/pull/12), owner/repo#12, or owner/repo/pull/12.");

export function createGitHubPlugin(deps: GitHubPluginDeps): (bb: BbPluginApi) => Promise<void> {
  return async (bb) => {
    const apiUrl = deps.apiUrl ?? GITHUB_API_URL;

    // ---- the token ----------------------------------------------------------

    let cached: { token: string; at: number } | null = null;

    async function accessToken(): Promise<string> {
      if (cached !== null && deps.now() - cached.at < TOKEN_CACHE_MS) return cached.token;
      const token = await deps.token();
      cached = { token, at: deps.now() };
      return token;
    }

    /** A fresh read from gh, whatever the cache says: GitHub refused the one we had. */
    async function refreshToken(reason: string): Promise<string> {
      cached = null;
      const token = await accessToken();
      bb.log.info(`GitHub token re-read from gh (${reason})`);
      return token;
    }

    // ---- talking to GitHub as the developer -----------------------------------

    /**
     * One call with the token. A 401 means GitHub refused the token, not the
     * request, so it is re-read from gh and the call made once more.
     */
    async function asDeveloper<T>(call: (token: string) => Promise<T>): Promise<T> {
      try {
        return await call(await accessToken());
      } catch (error) {
        if (!(error instanceof GitHubRequestError && error.status === 401)) throw error;
        return await call(await refreshToken("GitHub answered 401"));
      }
    }

    const query = (document: string, variables: Record<string, unknown>, signal: AbortSignal) => asDeveloper((token) => graphql(apiUrl, token, document, variables, deps.fetch, signal));

    /** One target read with the given document, unparsed: a watch and stewards' snapshot read the same answer two ways. */
    function readTargetDocument(document: string, ref: { repo: string; number: number }, signal: AbortSignal): Promise<unknown> {
      const [owner, name] = ref.repo.split("/") as [string, string];
      return query(document, { owner, name, number: ref.number }, signal);
    }

    /**
     * The target's read for the watch, without the sub-issue relations a watch
     * never uses: a GitHub that rejects those fields answers 200 with `errors`
     * and no data, which would fail the whole watch if they rode along (BB-244).
     */
    function readTargetPayload(ref: { repo: string; number: number }, signal: AbortSignal): Promise<unknown> {
      return readTargetDocument(TARGET_QUERY_BASE, ref, signal);
    }

    /**
     * The target and its sub-issue relations for stewards' snapshot. When the
     * relation fields are rejected, or the read errors or is rate-limited, the
     * target is read again without them and the snapshot is marked unread, so
     * its other fields survive (BB-244).
     */
    async function readSnapshot(ref: { repo: string; number: number }, signal: AbortSignal): Promise<EntitySnapshot | null> {
      let payload: unknown;
      let snapshot: EntitySnapshot | null;
      try {
        payload = await readTargetDocument(TARGET_QUERY, ref, signal);
        snapshot = parseSnapshot(payload);
      } catch (error) {
        try {
          payload = await readTargetDocument(TARGET_QUERY_BASE, ref, signal);
          snapshot = parseSnapshot(payload, true);
        } catch {
          throw error;
        }
      }
      if (snapshot === null || snapshot.pull === null || snapshot.pull === undefined) return snapshot;
      // BB-279: the retarget rule fires only when the base ref changed after
      // the approval, so the merge-base is read only then. A read that fails,
      // or a read that does not name the default branch, leaves the field null,
      // which the gate reads as "cannot tell" and fails closed. A pull request
      // based on the default branch throughout that is merely behind never
      // triggers the read, and stays gate-met.
      if ((snapshot.pull.baseChangedAt ?? null) === null) return snapshot;
      const defaultBranch = parseDefaultBranch(payload);
      const headSha = snapshot.pull.headSha;
      if (defaultBranch === null || headSha === null) return snapshot;
      try {
        const body = (await restPage(comparePath(snapshot.unit, defaultBranch, headSha), signal)).body;
        return { ...snapshot, pull: { ...snapshot.pull, headMergeBaseIsDefaultTip: parseMergeBaseIsDefaultTip(body) } };
      } catch (error) {
        bb.log.warn(`github-watcher: could not read the merge base of ${snapshot.key} with ${defaultBranch} (${errorMessage(error)}); the gate fails closed`);
        return snapshot;
      }
    }

    /** The target as the developer, or null when it does not exist or is not visible. */
    async function readTarget(ref: { repo: string; number: number }, signal: AbortSignal): Promise<Target | null> {
      return parseTarget(await readTargetPayload(ref, signal));
    }

    /**
     * One REST page with the token, for what GraphQL does not expose:
     * Dependabot alerts. A non-2xx answer throws with the status, so a 403 or
     * 404 (no alert access, alerts off, not visible) can be told apart from a
     * network failure and named per repository by the caller. The `next` URL
     * is from the `Link` header, so a repository with more than one page of
     * alerts is read whole.
     */
    async function restPage(path: string, signal: AbortSignal): Promise<{ body: unknown; next: string | null }> {
      return asDeveloper(async (token) => {
        const response = await deps.fetch(new URL(path, apiUrl), {
          method: "GET",
          headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "bb-plugin-github", "x-github-api-version": "2022-11-28" },
          signal,
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message = body !== null && typeof body === "object" && typeof (body as { message?: unknown }).message === "string" ? (body as { message: string }).message : "";
          throw new GitHubRequestError(`GitHub answered HTTP ${response.status}${message === "" ? "" : `: ${message}`}`, response.status);
        }
        const link = response.headers.get("link") ?? "";
        const next = /<([^>]+)>;\s*rel="next"/u.exec(link)?.[1] ?? null;
        return { body, next };
      });
    }

    /**
     * One REST write with the token, for the issue create and its sub-issue
     * link. A non-2xx answer throws with its status, like `restPage`; the
     * token is re-read from gh on a 401 by `asDeveloper`.
     */
    async function restWrite(path: string, body: unknown, signal: AbortSignal, method: "POST" | "PATCH" = "POST"): Promise<unknown> {
      return asDeveloper(async (token) => {
        const response = await deps.fetch(new URL(path, apiUrl), {
          method,
          headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "bb-plugin-github", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message = payload !== null && typeof payload === "object" && typeof (payload as { message?: unknown }).message === "string" ? (payload as { message: string }).message : "";
          throw new GitHubRequestError(`GitHub answered HTTP ${response.status}${message === "" ? "" : `: ${message}`}`, response.status);
        }
        return payload;
      });
    }

    /**
     * Create one label in one repository. A 422 `already_exists` is the label
     * already being there, which an idempotent create reports as `existed`;
     * every other non-2xx answer throws with its status. The token is re-read
     * from gh on a 401 by `asDeveloper`.
     */
    async function createLabel(repo: string, label: string, signal: AbortSignal): Promise<"created" | "existed"> {
      return asDeveloper(async (token) => {
        const response = await deps.fetch(new URL(labelPath(repo), apiUrl), {
          method: "POST",
          headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "bb-plugin-github", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
          body: JSON.stringify({ name: label }),
          signal,
        });
        if (response.ok) return "created";
        const body: unknown = await response.json().catch(() => null);
        if (response.status === 422 && labelAlreadyExists(body)) return "existed";
        const message = body !== null && typeof body === "object" && typeof (body as { message?: unknown }).message === "string" ? (body as { message: string }).message : "";
        throw new GitHubRequestError(`GitHub answered HTTP ${response.status}${message === "" ? "" : `: ${message}`}`, response.status);
      });
    }

    // ---- watching -----------------------------------------------------------
    //
    // The row is the truth: it carries what the thread last saw, and every
    // check compares a fresh read against it. The lease only makes the check
    // prompt. Without BB_HOOKS_URL there is no service to lease from and the
    // tool says so; a watch that merely polled would be a different feature.

    const hooksUrl = deps.env[HOOKS_URL_ENV]?.trim() ?? "";
    const db = bb.storage.database();
    bb.storage.migrate(db, WATCH_MIGRATIONS);
    const watches = createWatchStore(db, deps.now);
    const checkSignal = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    /** The settings section re-reads the usage view on this. */
    const announceWatches = () => bb.realtime.publish(WATCHES_CHANGED, {});

    /** Message a thread. "gone" when the thread no longer exists, so the caller drops the watch. */
    async function wake(threadId: string, text: string): Promise<"sent" | "gone" | "failed"> {
      try {
        await bb.sdk.threads.send({ threadId, input: [{ type: "text", text, mentions: [] }], mode: "auto" });
        return "sent";
      } catch (error) {
        const e = error as { code?: string; status?: number };
        if (e.code === "NOT_FOUND" || e.status === 404 || e.status === 410) return "gone";
        bb.log.warn(`could not wake thread ${threadId} for a GitHub change: ${errorMessage(error)}`);
        return "failed";
      }
    }

    /** The target is gone or no longer readable as the developer: tell the thread once and forget the watch. */
    async function dropInvisible(watch: WatchRow): Promise<void> {
      watches.remove(watch.threadId, watch.key);
      announceWatches();
      await wake(watch.threadId, `GitHub ${kindName(watch.kind)} ${watch.key} is no longer visible to the signed-in GitHub user (deleted, transferred, or access removed), so this thread has stopped watching it.`);
    }

    /** Read the target once and settle every watch on it against what it remembers. */
    async function checkKey(key: string): Promise<void> {
      const watching = watches.forKey(key);
      if (watching.length === 0) {
        clearNoChecksTimer(key);
        return;
      }
      const ref = parseRefKey(key);
      let target: Target | null;
      try {
        target = ref === null ? null : await readTarget(ref, checkSignal());
      } catch (error) {
        // Left as it was: the cursors still point at the last thing seen, so
        // the next doorbell or sweep reports everything since then.
        bb.log.warn(`could not read GitHub ${key} for its watchers: ${errorMessage(error)}`);
        return;
      }
      for (const watch of watching) {
        if (target === null) {
          await dropInvisible(watch);
          continue;
        }
        const outcome = compare(watch, target, deps.now());
        if (outcome.message === null) {
          watches.advance(watch.threadId, watch.key, outcome, false);
          continue;
        }
        const sent = await wake(watch.threadId, outcome.message);
        if (sent === "gone") watches.remove(watch.threadId, watch.key);
        else if (sent === "sent") watches.advance(watch.threadId, watch.key, outcome, true);
        if (sent !== "failed") announceWatches();
      }
      scheduleNoChecks(key);
    }

    const checks = createCheckQueue(checkKey, { onError: (key, error) => bb.log.warn(`GitHub watch check of ${key} failed: ${errorMessage(error)}`) });
    bb.onDispose(() => checks.stop());

    // A head with no checks produces no doorbell after the push, and the
    // baseline sweep can be up to ten minutes late, so a one-shot timer rings
    // the key at `since + grace`. It is re-armed after every check from the
    // stored rows, and at start for any row already pending; the baseline and
    // down sweeps are the backstop when the timer has already fired and the
    // wake could not be sent.
    const noChecksTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function clearNoChecksTimer(key: string): void {
      const timer = noChecksTimers.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        noChecksTimers.delete(key);
      }
    }

    /** The soonest `since + grace` among a key's watches with a pending, unwoken no-checks head. */
    function noChecksDue(key: string): number | null {
      let due: number | null = null;
      for (const watch of watches.forKey(key)) {
        const since = watch.noChecksSince;
        if (since === null || watch.noChecksWoken === since.sha) continue;
        const at = since.at + NO_CHECKS_GRACE_MS;
        if (due === null || at < due) due = at;
      }
      return due;
    }

    /** Arm the one-shot check at the grace. `past` arms a stored row already past it (plugin start). */
    function scheduleNoChecks(key: string, past = false): void {
      clearNoChecksTimer(key);
      const due = noChecksDue(key);
      if (due === null) return;
      const now = deps.now();
      if (!past && now >= due) return; // the grace was just checked; the sweep is the backstop
      noChecksTimers.set(
        key,
        setTimeout(() => {
          noChecksTimers.delete(key);
          checks.ring(key);
        }, Math.max(0, due - now)),
      );
    }

    bb.onDispose(() => {
      for (const timer of noChecksTimers.values()) clearTimeout(timer);
      noChecksTimers.clear();
    });

    // A row that was already waiting when the server restarted: ring it now
    // when its grace has passed, or at the grace when it has not.
    for (const key of watches.keys()) scheduleNoChecks(key, true);

    async function sweep(reason: string): Promise<void> {
      const expired = watches.expire();
      if (expired > 0) {
        bb.log.info(`forgot ${expired} GitHub watch${expired === 1 ? "" : "es"} idle for a week`);
        announceWatches();
      }
      const keys = watches.keys();
      if (keys.length > 0) bb.log.info(`checking ${keys.length} watched GitHub pull request${keys.length === 1 ? "" : "s"} or issue${keys.length === 1 ? "" : "s"} (${reason})`);
      await checks.sweep(keys);
      // BB-286: a reconnect re-check must also ring stewards for every repo
      // whose deployment doorbells it holds. A deployment doorbell dropped
      // while this server was away is otherwise only found by the half-hourly
      // sweep; the ring makes stewards re-read that repo's deployments now.
      if (reason === "connected") {
        for (const repo of interest.deployment) rings.ring(repo);
      }
    }

    // ---- what stewards wants to hear about ------------------------------------
    //
    // Stewards names repositories (to hear of new pull requests) and the pull
    // requests and issues it has bound. They are leased beside the watches,
    // and a doorbell for one of them is passed on as `stewardsRing`; whether
    // anything changed is stewards' question, as a watch's is watch.ts's.
    // Kept in kv so a restart leases them again before stewards next says.

    const storedInterest = interestSchema.safeParse(await bb.storage.kv.get(INTEREST_KEY));
    let interest: Interest = storedInterest.success ? storedInterest.data : { units: [], entities: [], dependabot: [], deployment: [] };
    // GitHub's names are case-insensitive, and a doorbell spells them as
    // GitHub does, which need not be how a project file does.
    let interestRepos = new Set(interest.units.map((u) => u.toLowerCase()));
    let interestEntities = new Set(interest.entities.map((e) => e.toLowerCase()));
    let interestDependabot = new Set(interest.dependabot.map((r) => r.toLowerCase()));
    let interestDeployment = new Set(interest.deployment.map((r) => r.toLowerCase()));
    /** Stewards' leases the hooks service refused, by `<kind> <lowercased id>`. */
    const refusals = createRefusals(deps.now);

    /** Every lease to hold: the watches, then stewards' entities, repositories and Dependabot repositories, each once. */
    function leases(): Lease[] {
      const seen = new Set<string>();
      const out: Lease[] = [];
      const add = (kind: Lease["kind"], id: string) => {
        const k = `${kind} ${id.toLowerCase()}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ kind, id });
      };
      for (const key of watches.keys()) add("issue", key);
      for (const key of interest.entities) add("issue", key);
      for (const repo of interest.units) add("repo", repo);
      for (const repo of interest.dependabot) add("dependabot_repo", repo);
      for (const repo of interest.deployment) add("deployment_repo", repo);
      return out;
    }

    /** Whether stewards cares about a doorbell for this key, in this repository. */
    function interesting(kind: string, key: string, unit: string | null): boolean {
      const repo = unit ?? parseRefKey(key)?.repo ?? null;
      if (kind === "dependabot_alert") return repo !== null && interestDependabot.has(repo.toLowerCase());
      // A workflow_run doorbell shares the deployment_repo lease: only a
      // project that names a deployment target cares about a failed run.
      if (kind === "deployment" || kind === "workflow_run") return repo !== null && interestDeployment.has(repo.toLowerCase());
      if (interestEntities.has(key.toLowerCase())) return true;
      return repo !== null && interestRepos.has(repo.toLowerCase());
    }

    // Debounced per key like a watch's check, so a push and its three check
    // runs are one ring. stewardsRing never throws; a missing stewards is quiet.
    const callStewards = <T>(args: { pluginId: string; method: string; input: unknown; outputSchema: z.ZodType<T> }) => bb.sdk.plugins.callRpc<T>({ ...args, input: args.input as JsonValue });
    const warn = (message: string) => bb.log.warn(message);
    const rings = createCheckQueue((key) => ringStewards(callStewards, { source: "github", id: key }, warn), { onError: (key, error) => warn(`ringing stewards for ${key} failed: ${errorMessage(error)}`) });
    bb.onDispose(() => rings.stop());

    // A deployment doorbell carries its deployment object, which a plain ring
    // does not; the queue holds the latest per deployment id and the ring
    // hands it on. A doorbell with no readable object is dropped: there is
    // nothing to decide carries from.
    const pendingDeployments = new Map<string, Deployment>();
    const deploymentRings = createCheckQueue(
      (id) => {
        const deployment = pendingDeployments.get(id);
        pendingDeployments.delete(id);
        if (deployment === undefined) return Promise.resolve();
        return ringStewards(callStewards, { source: "github", id, deployment }, warn);
      },
      { onError: (id, error) => warn(`ringing stewards for deployment ${id} failed: ${errorMessage(error)}`) },
    );
    bb.onDispose(() => deploymentRings.stop());

    // A workflow_run doorbell carries its run object the same way. It is keyed
    // by the run id and attempt, so a re-run that fails again is its own ring
    // rather than being coalesced into the first.
    const pendingWorkflowRuns = new Map<string, { id: string; run: WorkflowRun }>();
    const workflowRunRings = createCheckQueue(
      (eventKey) => {
        const pending = pendingWorkflowRuns.get(eventKey);
        pendingWorkflowRuns.delete(eventKey);
        if (pending === undefined) return Promise.resolve();
        return ringStewards(callStewards, { source: "github", id: pending.id, workflow_run: pending.run }, warn);
      },
      { onError: (eventKey, error) => warn(`ringing stewards for workflow run ${eventKey} failed: ${errorMessage(error)}`) },
    );
    bb.onDispose(() => workflowRunRings.stop());

    // The service refusing a lease is not proof the developer lost access:
    // with GitHub rate-limiting the service, or briefly down, every watch
    // would come back `forbidden`. The developer's own read is the ground
    // truth, so a refused target is read here before the thread is told it
    // is gone; one that reads fine keeps its watch and is leased again at
    // the next renewal.
    //
    // Leases stewards asked for are only logged: stewards still reads the
    // entity itself on its nightly pass, and says what it wants again.
    async function onRejected(rejected: Rejection[]): Promise<void> {
      for (const r of rejected) {
        const watching = r.kind === "issue" ? watches.forKey(r.id) : [];
        const leased =
          r.kind === "repo"
            ? interestRepos.has(r.id.toLowerCase())
            : r.kind === "dependabot_repo"
              ? interestDependabot.has(r.id.toLowerCase())
              : r.kind === "deployment_repo"
                ? interestDeployment.has(r.id.toLowerCase())
                : interestEntities.has(r.id.toLowerCase());
        if (leased) refusals.add(`${r.kind} ${r.id.toLowerCase()}`, r.reason);
        if (r.kind === "dependabot_repo") {
          // A login that cannot read alerts gets `forbidden` here. That is a
          // skip, not an error: the server keeps running without Dependabot
          // doorbells, and `bb stewards check` says which repos it skips.
          if (interestDependabot.has(r.id.toLowerCase())) bb.log.info(`the hooks service refused a dependabot_repo lease on ${r.id} (${r.reason}); this server skips Dependabot alerts there`);
          continue;
        }
        if (r.kind === "deployment_repo") {
          // Reading a repository's deployments needs `deployments:read` (or
          // the `repo` scope); a token without it is refused here, which is a
          // skip: the server keeps running without deployment doorbells.
          if (interestDeployment.has(r.id.toLowerCase())) bb.log.info(`the hooks service refused a deployment_repo lease on ${r.id} (${r.reason}); this server skips deployment and workflow-run doorbells there`);
          continue;
        }
        if (r.kind === "repo" || (watching.length === 0 && interestEntities.has(r.id.toLowerCase()))) {
          bb.log.warn(`the hooks service refused a lease on ${r.kind === "repo" ? `repository ${r.id}` : r.id} for stewards (${r.reason}); stewards will not be rung for it`);
          continue;
        }
        if (r.kind !== "issue" || r.reason !== "forbidden") continue;
        if (watching.length === 0) continue;
        const ref = parseRefKey(r.id);
        try {
          if (ref !== null && (await readTarget(ref, checkSignal())) !== null) {
            bb.log.warn(`the hooks service refused a lease on ${r.id} that the signed-in user can read; keeping the watch`);
            continue;
          }
        } catch (error) {
          bb.log.warn(`could not confirm a refused lease on ${r.id}: ${errorMessage(error)}`);
          continue;
        }
        for (const watch of watching) await dropInvisible(watch);
      }
    }

    const hooks = createHooksLoop({
      fetch: deps.fetch,
      baseUrl: hooksUrl,
      now: deps.now,
      log: bb.log,
      token: accessToken,
      refreshToken: () => refreshToken("was refused by the hooks service"),
      watchIds: leases,
      onDoorbell: (kind, key, unit, deployment, workflowRun) => {
        if (kind === "issue") checks.ring(key);
        if (kind === "workflow_run") {
          if (!interesting(kind, key, unit)) return;
          const parsed = workflowRunSchema.safeParse(workflowRun);
          if (!parsed.success) {
            bb.log.warn(`GitHub workflow_run doorbell ${key} carried no readable run; nothing to hand stewards`);
            return;
          }
          const eventKey = `${key.toLowerCase()}#${parsed.data.run_attempt}`;
          pendingWorkflowRuns.set(eventKey, { id: key, run: parsed.data });
          workflowRunRings.ring(eventKey);
          return;
        }
        if (kind === "deployment") {
          if (!interesting(kind, key, unit)) return;
          const parsed = deploymentSchema.safeParse(deployment);
          if (!parsed.success) {
            bb.log.warn(`GitHub deployment doorbell ${key} carried no readable deployment; nothing to hand stewards`);
            return;
          }
          pendingDeployments.set(key, parsed.data);
          deploymentRings.ring(key);
          return;
        }
        if (interesting(kind, key, unit)) rings.ring(key);
      },
      onRejected,
      sweep,
    });
    hooks.onStateChange(announceWatches);

    // ---- polling, when there is no hooks service ------------------------------
    //
    // `BB_HOOKS_URL` unset means no doorbells: the plugin still watches, but
    // on its own timer. Every round re-checks the open watches (the same
    // baseline re-check the hooks client runs while leased) and polls the
    // repositories stewards asked to hear about, ringing stewards for a new
    // labelled pull request, a review request, a Dependabot alert or a
    // deployment exactly as a doorbell would. The reads are REST so they can
    // be conditional (ETag) and so a 403/429 or a near-empty quota can be
    // seen and backed off from.

    /** The last fingerprint the poller saw per interest entity, so an unchanged one is not rung again. */
    const storedCursors = await bb.storage.kv.get<Record<string, { fp: string; at: number }>>(INTEREST_CURSORS_KEY);
    let interestCursors: Record<string, { fp: string; at: number }> = storedCursors !== null && typeof storedCursors === "object" ? storedCursors : {};

    /** The ETag the last read of a path returned, so an unchanged list answers 304. */
    const pollEtags = new Map<string, string>();

    /** The last status parsed per deployment, so a conditional 304 reuses it instead of reading as empty. */
    const deploymentStatusCache = new Map<string, { state: string; url: string | null }>();

    /**
     * One conditional REST read for the poller. A 304 is "nothing changed".
     * A 429, or a 403 that also carries a rate-limit signal (a near-empty
     * quota, a `Retry-After`, or a rate-limit message), is a RateLimitError
     * with the server's retry hint, so the poller backs off. Any other 403 is
     * an ordinary read failure: GitHub answers 403 for a Dependabot repo
     * whose alerts are off or whose token has no alert access, and that must
     * not starve the whole poller. Each request gets its own timeout, so a
     * long round does not abort the reads at its end.
     */
    async function pollRest(path: string): Promise<{ body: unknown; notModified: boolean; retryAfterMs: number | null }> {
      return asDeveloper(async (token) => {
        const headers: Record<string, string> = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "bb-plugin-github", "x-github-api-version": "2022-11-28" };
        const etag = pollEtags.get(path);
        if (etag !== undefined) headers["if-none-match"] = etag;
        const response = await deps.fetch(new URL(path, apiUrl), { method: "GET", headers, signal: checkSignal() });
        if (response.status === 304) return { body: null, notModified: true, retryAfterMs: null };
        const remainingRaw = response.headers.get("x-ratelimit-remaining");
        const resetRaw = response.headers.get("x-ratelimit-reset");
        const retryAfterRaw = response.headers.get("retry-after");
        const remaining = remainingRaw === null ? Number.NaN : Number(remainingRaw);
        const reset = resetRaw === null ? Number.NaN : Number(resetRaw);
        const retryAfter = retryAfterRaw === null ? Number.NaN : Number(retryAfterRaw);
        const lowQuota = Number.isFinite(remaining) && remaining <= RATE_LIMIT_FLOOR;
        const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : lowQuota && Number.isFinite(reset) ? Math.max(0, reset * 1000 - deps.now()) : null;
        if (response.status === 429) throw new RateLimitError(`GitHub answered HTTP 429 to ${path}`, retryAfterMs);
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null);
          const message = body !== null && typeof body === "object" && typeof (body as { message?: unknown }).message === "string" ? (body as { message: string }).message : "";
          if (response.status === 403 && (lowQuota || retryAfterMs !== null || /rate.?limit|secondary rate/iu.test(message))) {
            throw new RateLimitError(`GitHub answered HTTP 403 to ${path}${message === "" ? "" : `: ${message}`}`, retryAfterMs);
          }
          throw new GitHubRequestError(`GitHub answered HTTP ${response.status}${message === "" ? "" : `: ${message}`}`, response.status);
        }
        const newEtag = response.headers.get("etag");
        if (newEtag !== null && newEtag !== "") pollEtags.set(path, newEtag);
        const body: unknown = await response.json().catch(() => null);
        return { body, notModified: false, retryAfterMs: lowQuota ? retryAfterMs : null };
      });
    }

    /**
     * Poll the repositories stewards asked to hear about, ringing stewards for
     * each entity whose fingerprint changed since the last poll. The per-poll
     * cap bounds how many are rung in one round; the rest keep their old
     * cursor and are rung next round.
     */
    async function pollInterest(): Promise<PollResult> {
      if (interest.units.length === 0 && interest.dependabot.length === 0 && interest.deployment.length === 0) return {};
      const changed: Array<{ id: string; fp: string; ring: () => void }> = [];
      let rateLimited: { retryAfterMs: number | null; message: string } | undefined;
      const noteRateLimit = (ms: number | null, message: string) => {
        if (rateLimited === undefined) rateLimited = { retryAfterMs: ms, message };
      };
      const noteQuota = (ms: number | null) => noteRateLimit(ms, "GitHub's remaining rate-limit quota is nearly exhausted");
      const seen = (id: string, fp: string): boolean => interestCursors[id]?.fp === fp;

      for (const repo of interest.units) {
        try {
          const page = await pollRest(pullsPath(repo));
          if (page.retryAfterMs !== null) noteQuota(page.retryAfterMs);
          if (page.notModified) continue;
          for (const pr of parsePulls(page.body, repo)) {
            const id = `issue ${pr.key.toLowerCase()}`;
            const fp = pr.updatedAt ?? "";
            if (seen(id, fp)) continue;
            changed.push({ id, fp, ring: () => rings.ring(pr.key) });
          }
        } catch (error) {
          if (error instanceof RateLimitError) noteRateLimit(error.retryAfterMs, error.message);
          else bb.log.warn(`github-watcher: polling ${repo} pull requests failed: ${errorMessage(error)}`);
        }
      }

      for (const repo of interest.dependabot) {
        try {
          const page = await pollRest(dependabotAlertsPath(repo, "open"));
          if (page.retryAfterMs !== null) noteQuota(page.retryAfterMs);
          if (page.notModified) continue;
          for (const alert of parseDependabotAlerts(page.body, repo)) {
            const id = `dependabot_alert ${alert.id.toLowerCase()}`;
            const fp = alert.updatedAt ?? "";
            if (seen(id, fp)) continue;
            changed.push({ id, fp, ring: () => rings.ring(alert.id) });
          }
        } catch (error) {
          if (error instanceof RateLimitError) noteRateLimit(error.retryAfterMs, error.message);
          else bb.log.warn(`github-watcher: polling ${repo} Dependabot alerts failed: ${errorMessage(error)}`);
        }
      }

      for (const repo of interest.deployment) {
        try {
          const page = await pollRest(deploymentsPath(repo));
          if (page.retryAfterMs !== null) noteQuota(page.retryAfterMs);
          if (page.notModified) continue;
          const deployments = parseDeployments(page.body).slice(0, DEPLOYMENTS_PER_POLL);
          for (const d of deployments) {
            const key = `${repo}#${d.id}`;
            const cached = deploymentStatusCache.get(key);
            let state = cached?.state ?? "";
            let url = cached?.url ?? d.url;
            try {
              const statusPage = await pollRest(deploymentStatusesPath(repo, d.id));
              if (statusPage.retryAfterMs !== null) noteQuota(statusPage.retryAfterMs);
              if (!statusPage.notModified) {
                const status = parseDeploymentStatus(statusPage.body);
                state = status.state;
                url = status.url ?? d.url;
                deploymentStatusCache.set(key, { state, url });
              }
            } catch (error) {
              if (error instanceof RateLimitError) noteRateLimit(error.retryAfterMs, error.message);
              else bb.log.warn(`github-watcher: polling the status of deployment ${key} failed: ${errorMessage(error)}`);
            }
            const id = `deployment ${key.toLowerCase()}`;
            const fp = `${d.id}:${state}`;
            if (seen(id, fp)) continue;
            const deployment: Deployment = { id: d.id, environment: d.environment, ref: d.ref, sha: d.sha, state, url };
            changed.push({
              id,
              fp,
              ring: () => {
                pendingDeployments.set(key, deployment);
                deploymentRings.ring(key);
              },
            });
          }
        } catch (error) {
          if (error instanceof RateLimitError) noteRateLimit(error.retryAfterMs, error.message);
          else bb.log.warn(`github-watcher: polling ${repo} deployments failed: ${errorMessage(error)}`);
        }
      }

      // Ring, in the order the reads found them, up to the cap. What is left
      // keeps its old cursor and is rung next round.
      const timing: PollerTiming = { ...DEFAULT_POLL_TIMING, ...deps.pollTiming };
      let budget = timing.maxEntitiesPerPoll;
      let capped = false;
      const next = { ...interestCursors };
      for (const c of changed) {
        if (budget <= 0) {
          capped = true;
          break;
        }
        budget -= 1;
        c.ring();
        next[c.id] = { fp: c.fp, at: deps.now() };
      }
      // Bound the cursor map: drop the oldest entries once it grows past the cap.
      const cursorIds = Object.keys(next);
      if (cursorIds.length > INTEREST_CURSOR_MAX) {
        cursorIds.sort((a, b) => next[a]!.at - next[b]!.at);
        for (const id of cursorIds.slice(0, cursorIds.length - INTEREST_CURSOR_MAX)) delete next[id];
      }
      interestCursors = next;
      await bb.storage.kv.set(INTEREST_CURSORS_KEY, next);
      if (rateLimited !== undefined) return { rateLimited: true, retryAfterMs: rateLimited.retryAfterMs ?? undefined, message: rateLimited.message };
      return { capped };
    }

    /** The polling timer: only meaningful when there is no hooks service, but harmless otherwise. */
    const poller: Poller = createPoller({
      now: deps.now,
      log: bb.log,
      timing: deps.pollTiming,
      poll: async (reason) => {
        await sweep(reason);
        return pollInterest();
      },
    });
    poller.onStateChange(announceWatches);

    /**
     * The usage view: every watch with its counters, flags and thread title,
     * and the doorbell stream's state. Titles come from bb per thread; a
     * thread that cannot be read shows its id.
     */
    async function usage() {
      const rows = watches.all();
      const titles = new Map<string, string | null>();
      await Promise.all(
        [...new Set(rows.map((r) => r.threadId))].map(async (threadId) => {
          try {
            const thread = (await bb.sdk.threads.get({ threadId })) as { title?: string | null; titleFallback?: string | null };
            titles.set(threadId, thread.title ?? thread.titleFallback ?? null);
          } catch {
            titles.set(threadId, null);
          }
        }),
      );
      return buildUsage({
        rows,
        hooks: hooks.status(),
        configured: hooksUrl !== "",
        poll: hooksUrl === "" ? poller.status() : null,
        now: deps.now(),
        titles,
        target: (row) => {
          const ref = parseRefKey(row.key);
          const url = ref === null ? null : `https://github.com/${ref.repo}/${row.kind === "pull" ? "pull" : "issues"}/${ref.number}`;
          return { id: row.key, key: row.key, kind: row.kind, title: row.snapshot.title, url };
        },
        interest: interestView(),
      });
    }

    /** Stewards' interest as a person reads it, with whatever the hooks service refused of it. */
    function interestView(): InterestView {
      const refused = refusals.current();
      const unleased: InterestView["unleased"] = [];
      for (const repo of interest.units) {
        const reason = refused.get(`repo ${repo.toLowerCase()}`);
        if (reason !== undefined) unleased.push({ key: repo, reason: `refused by the hooks service (${reason})` });
      }
      for (const key of interest.entities) {
        const reason = refused.get(`issue ${key.toLowerCase()}`);
        if (reason !== undefined) unleased.push({ key, reason: `refused by the hooks service (${reason})` });
      }
      for (const repo of interest.dependabot) {
        const reason = refused.get(`dependabot_repo ${repo.toLowerCase()}`);
        if (reason !== undefined) unleased.push({ key: repo, reason: `refused by the hooks service (${reason}); Dependabot alerts are skipped` });
      }
      for (const repo of interest.deployment) {
        const reason = refused.get(`deployment_repo ${repo.toLowerCase()}`);
        if (reason !== undefined) unleased.push({ key: repo, reason: `refused by the hooks service (${reason}); deployment and workflow-run doorbells are skipped` });
      }
      return {
        nouns: { unit: ["repository", "repositories"], entity: ["pull request", "pull requests"] },
        units: interest.units,
        dependabot: [...interest.dependabot].sort((a, b) => a.localeCompare(b)),
        deployment: [...interest.deployment].sort((a, b) => a.localeCompare(b)),
        entities: [...interest.entities].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((key) => {
          const ref = parseRefKey(key);
          // GitHub sends /issues/N on to the pull request when it is one.
          return { key, url: ref === null ? null : `https://github.com/${ref.repo}/issues/${ref.number}` };
        }),
        unleased,
      };
    }

    bb.rpc.register(rpcContract, {
      watches: () => usage(),
      async unwatch({ threadId, targetId }) {
        const removed = watches.get(threadId, targetId) !== null;
        if (removed) {
          watches.remove(threadId, targetId);
          bb.log.info(`watch on ${targetId} by thread ${threadId} removed from settings`);
          announceWatches();
        }
        return { removed };
      },

      async sourceSnapshot({ id }) {
        const ref = parseRef(id);
        if (ref === null) return { snapshot: null };
        return { snapshot: await readSnapshot(ref, checkSignal()) };
      },

      // The repository's label, and each of `states` as a label name (the
      // GitHub side of a playbook's states: a status label). A gh that is not
      // signed in is an answer here (`error`), not a failure: it is the first
      // thing `bb stewards check` should say.
      async sourceValidate({ units, label, states }) {
        let viewer: string;
        try {
          viewer = parseViewer(await query(VIEWER_QUERY, {}, checkSignal()));
        } catch (error) {
          return { viewer: null, units: [], mine: [], error: errorMessage(error) };
        }
        const checked: Array<{ unit: string; found: boolean; labelFound: boolean; missingStates: string[] }> = [];
        try {
          for (const unit of units) {
            const repo = parseRepo(unit);
            if (repo === null) {
              checked.push({ unit, found: false, labelFound: false, missingStates: [] });
              continue;
            }
            const found = parseRepoCheck(await query(REPO_CHECK_QUERY, { ...repo, label }, checkSignal()));
            const missingStates: string[] = [];
            if (found.found) {
              for (const state of states) {
                const check = parseRepoCheck(await query(REPO_CHECK_QUERY, { ...repo, label: state }, checkSignal()));
                if (!check.labelFound) missingStates.push(state);
              }
            }
            checked.push({ unit, found: found.found, labelFound: found.labelFound, missingStates });
          }
        } catch (error) {
          return { viewer, units: [], mine: [], error: errorMessage(error) };
        }
        return { viewer, units: checked, mine: [], error: null };
      },

      // The project's label in each repository, for onboarding. A repository
      // that is not visible, or a label that is already there, is answered
      // per unit rather than failing the call. The units are stewards'
      // project config, which has already dropped `github.exclude`, so an
      // excluded repository is never passed here.
      async sourceEnsureLabel({ units, label }) {
        const results: Array<{ unit: string; status: "created" | "existed" | "error"; error: string | null }> = [];
        for (const unit of units) {
          const repo = parseRepo(unit);
          if (repo === null) {
            results.push({ unit, status: "error", error: "not owner/repo" });
            continue;
          }
          try {
            const check = parseRepoCheck(await query(REPO_CHECK_QUERY, { ...repo, label }, checkSignal()));
            if (!check.found) {
              results.push({ unit, status: "error", error: "no such repository, or it is not visible to the signed-in GitHub user" });
              continue;
            }
            if (check.labelFound) {
              results.push({ unit, status: "existed", error: null });
              continue;
            }
            // Use the parsed owner/name, not the raw unit: it is the canonical
            // spelling the lookup already used.
            results.push({ unit, status: await createLabel(`${repo.owner}/${repo.name}`, label, checkSignal()), error: null });
          } catch (error) {
            results.push({ unit, status: "error", error: errorMessage(error) });
          }
        }
        return { results };
      },

      // Each repository is read oldest first up to the limit, so the oldest
      // `limit` across all of them are among what was read. Pull requests and
      // the open issues carrying the label are merged into the one list.
      async sourceAdoptable({ units, label, limit }) {
        let viewer: string;
        try {
          viewer = parseViewer(await query(VIEWER_QUERY, {}, checkSignal()));
        } catch (error) {
          return { viewer: null, entities: [], errors: [errorMessage(error)] };
        }
        const entities: AdoptableEntity[] = [];
        const errors: string[] = [];
        // One list paged oldest first up to `limit`; null when the repository
        // is not there or not visible.
        const readAll = async (document: string, variables: Record<string, unknown>, parse: (payload: unknown) => { entities: AdoptableEntity[]; next: string | null } | null): Promise<AdoptableEntity[] | null> => {
          const out: AdoptableEntity[] = [];
          let after: string | null = null;
          do {
            const page = parse(await query(document, { ...variables, first: Math.min(100, limit - out.length), after }, checkSignal()));
            if (page === null) return null;
            out.push(...page.entities);
            after = page.next;
          } while (after !== null && out.length < limit);
          return out;
        };
        for (const unit of units) {
          const repo = parseRepo(unit);
          if (repo === null) {
            errors.push(`${unit}: not owner/repo`);
            continue;
          }
          const missing = `${unit}: no such repository, or it is not visible to the signed-in GitHub user`;
          try {
            const pulls = await readAll(OPEN_PULLS_QUERY, { ...repo }, parseOpenPulls);
            if (pulls === null) {
              errors.push(missing);
              continue;
            }
            entities.push(...pulls);
            const issues = await readAll(OPEN_ISSUES_QUERY, { ...repo, labels: [label] }, parseOpenIssues);
            if (issues === null) {
              errors.push(missing);
              continue;
            }
            entities.push(...issues);
          } catch (error) {
            errors.push(`${unit}: ${errorMessage(error)}`);
          }
        }
        entities.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
        return { viewer, entities: entities.slice(0, limit), errors };
      },

      // Issues matching a body term, one search per repository, closed
      // included: what stewards' dedup asks for. A repository that cannot be
      // read is an error rather than a failure of the whole call.
      async sourceSearchIssues({ units, query: term, limit }) {
        const issues: SearchIssue[] = [];
        const errors: string[] = [];
        for (const unit of units) {
          const repo = parseRepo(unit);
          if (repo === null) {
            errors.push(`${unit}: not owner/repo`);
            continue;
          }
          try {
            const q = `repo:${repo.owner}/${repo.name} in:body ${term}`;
            issues.push(...parseSearchIssues(await query(SEARCH_ISSUES_QUERY, { q, first: limit }, checkSignal())));
          } catch (error) {
            errors.push(`${unit}: ${errorMessage(error)}`);
          }
        }
        return { issues: issues.slice(0, limit), unsupported: false, errors };
      },

      // A repository's whole open backlog (BB-396), read-only: every open
      // issue, unlabelled and unassigned included, oldest first. The `team`
      // input carries the repository (`owner/repo`) on this source. Pull
      // requests are not in GitHub's `issues` connection, so none are read.
      // Pages stop at the cap and `truncated` says the cap cut the list rather
      // than the list having ended; a repository that cannot be read is an
      // error, never an empty-but-successful list.
      async sourceBacklog({ team }) {
        const repo = parseRepo(team);
        if (repo === null) return { issues: [], unsupported: false, truncated: false, errors: [`${team}: not owner/repo`] };
        try {
          const issues: BacklogIssue[] = [];
          let after: string | null = null;
          do {
            const page = parseBacklogIssues(await query(BACKLOG_ISSUES_QUERY, { ...repo, first: BACKLOG_PAGE, after }, checkSignal()));
            if (page === null) return { issues: [], unsupported: false, truncated: false, errors: [`${team}: no such repository, or it is not visible to the signed-in GitHub user`] };
            issues.push(...page.issues);
            after = page.next;
          } while (after !== null && issues.length < BACKLOG_MAX);
          const truncated = after !== null || issues.length > BACKLOG_MAX;
          return { issues: issues.slice(0, BACKLOG_MAX), unsupported: false, truncated, errors: [] };
        } catch (error) {
          return { issues: [], unsupported: false, truncated: false, errors: [`${team}: ${errorMessage(error)}`] };
        }
      },

      // BB-360: the source-neutral ticket_update. GitHub issues carry labels
      // and an open/closed state; a project's phases are `status:<phase>`
      // labels, so setting one replaces the others. Priority, assignee and
      // relations have no GitHub issue equivalent and are refused per field,
      // as the contract documents; the assignee rule is this server's own
      // login or none, exactly as sourceCreateIssue's.
      async sourceUpdateIssue({ key, addLabels, priority, state, assignee, relations }) {
        if (priority !== undefined) throw new Error("sourceUpdateIssue has no priority on the github source; GitHub issues have no priority");
        if (relations.length > 0) throw new Error("sourceUpdateIssue has no relations on the github source; GitHub issues have no relations");
        const ref = parseRefKey(key);
        if (ref === null) throw new Error(`${key} is not a GitHub issue key like owner/repo#12`);
        const snapshot = await readSnapshot(ref, checkSignal());
        if (snapshot === null) throw new Error(`${key} does not exist, or it is not visible to the signed-in GitHub user`);
        const body: Record<string, unknown> = {};
        const changed: string[] = [];
        const labels = new Set(snapshot.labels);
        for (const label of addLabels) labels.add(label);
        if (state !== undefined) {
          if (state === "open" || state === "closed" || state === "closed (not planned)") {
            body.state = state === "open" ? "open" : "closed";
            // GitHub records why a close happened; `closed` is completed, the
            // playbook's other terminal state is not planned.
            if (state !== "open") body.state_reason = state === "closed (not planned)" ? "not_planned" : "completed";
            changed.push(state === "open" ? "reopened" : state === "closed (not planned)" ? "closed as not planned" : "closed");
          } else if (state.startsWith("status:")) {
            for (const label of [...labels]) if (label.startsWith("status:")) labels.delete(label);
            labels.add(state);
            changed.push(`now ${state}`);
          } else {
            throw new Error(`sourceUpdateIssue has no state ${JSON.stringify(state)} on the github source; give open, closed, or a status:<phase> label`);
          }
        }
        if (assignee !== undefined) {
          const who = assignee.trim().toLowerCase();
          if (who === "me" || who === "nobody") {
            body.assignees = who === "me" ? [snapshot.viewer].filter((v): v is string => v !== null) : [];
            changed.push(who === "me" ? `assigned to ${snapshot.viewer ?? "this server's login"}` : "unassigned");
          } else if (snapshot.viewer !== null && who === snapshot.viewer.toLowerCase()) {
            body.assignees = [snapshot.viewer];
            changed.push(`assigned to ${snapshot.viewer}`);
          } else {
            throw new Error(`sourceUpdateIssue assigns only to this server's own login (${snapshot.viewer ?? "unknown"}), not ${JSON.stringify(assignee)}`);
          }
        }
        if (addLabels.length > 0 || (state !== undefined && state.startsWith("status:"))) body.labels = [...labels];
        if (Object.keys(body).length > 0) await restWrite(`${issuesPath(ref.repo)}/${ref.number}`, body, checkSignal(), "PATCH");
        if (addLabels.length > 0) changed.push(`labels ${[...labels].join(", ")}`);
        return { ok: true, changed };
      },
      // BB-360: the source-neutral ticket_comment. The caller has already
      // signed the body with the contract's signature line; an unsigned one is
      // refused here, exactly as sourceCreateIssue refuses an unsigned
      // description.
      async sourceComment({ key, body }) {
        if (signedBy(body) === null) throw new Error("a comment must end with the bb thread signature line; nothing was posted");
        const ref = parseRefKey(key);
        if (ref === null) throw new Error(`${key} is not a GitHub issue key like owner/repo#12`);
        const created = parseCreatedComment(await restWrite(`${issuesPath(ref.repo)}/${ref.number}/comments`, { body }, checkSignal()));
        return { ok: true, url: created.url };
      },

      // BB-360: file an issue for the source-neutral ticket tools. The caller
      // has already signed the description with the contract's signature line;
      // an unsigned one is refused here. GitHub issues have no priority, so a
      // priority is refused; a sub-issue's parent must be a same-repository
      // issue; and the assignee is this server's own login (me, @me or the
      // viewer) or none, never anyone else.
      async sourceCreateIssue({ unit, title, description, labels, priority, parent, assignee }) {
        if (signedBy(description) === null) throw new Error("an issue description must end with the bb thread signature line; nothing was filed");
        if (priority !== undefined) throw new Error("sourceCreateIssue has no priority on the github source; GitHub issues have no priority");
        const repo = parseRepo(unit);
        if (repo === null) throw new Error(`${unit}: not owner/repo`);
        const name = `${repo.owner}/${repo.name}`;
        const viewer = parseViewer(await query(VIEWER_QUERY, {}, checkSignal()));
        const who = assignee?.trim() ?? "";
        const self = who === "" || who.toLowerCase() === "me" || who.toLowerCase() === "@me" || who.toLowerCase() === `@${viewer.toLowerCase()}` || who.toLowerCase() === viewer.toLowerCase();
        if (!self) throw new Error(`sourceCreateIssue assigns only to this server's own login (${viewer}), not ${JSON.stringify(who)}`);
        // Resolve the parent before any write, so a missing or non-issue
        // parent changes nothing; a sub-issue is linked within one repository.
        const parentRef = parent === undefined ? null : parseRef(parent);
        if (parent !== undefined && parentRef === null) throw new Error(`parent ${JSON.stringify(parent)} is not a GitHub issue key like owner/repo#12`);
        if (parentRef !== null && parentRef.repo.toLowerCase() !== name.toLowerCase()) throw new Error(`a GitHub sub-issue's parent must be in the same repository; ${parent} is not in ${name}`);
        if (parentRef !== null) {
          const target = await readTarget(parentRef, checkSignal());
          if (target === null) throw new Error(`parent ${parent} does not exist, or it is not visible to the signed-in GitHub user`);
          if (target.kind !== "issue") throw new Error(`parent ${parent} is a pull request, not an issue; a sub-issue must be an issue`);
        }
        const body: Record<string, unknown> = { title: title.trim(), body: description };
        if (labels.length > 0) body.labels = labels;
        if (who !== "") body.assignees = [viewer];
        const created = parseCreatedIssue(await restWrite(issuesPath(name), body, checkSignal()));
        if (parentRef !== null) {
          try {
            await restWrite(subIssuesPath(name, parentRef.number), { sub_issue_id: created.id }, checkSignal());
          } catch (error) {
            throw new Error(`filed ${name}#${created.number}${created.url === null ? "" : ` (${created.url})`}, but could not link it under ${parent}: ${errorMessage(error)}`);
          }
        }
        return { id: `${name}#${created.number}`, key: `${name}#${created.number}`, url: created.url };
      },

      // A repository's Dependabot alerts, read with the token through the
      // REST API. Each repository the token cannot read (no alert access,
      // alerts disabled, not visible) is named in `errors`; the rest are
      // still returned. Reading alerts needs more than read access to the
      // repository (hooks.md, "Admission, alerts").
      //
      // One GraphQL read of `dependencyGraphManifests(first: 1) { totalCount }`
      // per repository says whether an empty alert list is the truth or a
      // dependency graph that has parsed nothing (BB-289); a failed graph read
      // is not an empty graph, so it is left unflagged and adds no error.
      async sourceDependabotAlerts({ units, state }) {
        let viewer: string;
        try {
          viewer = parseViewer(await query(VIEWER_QUERY, {}, checkSignal()));
        } catch (error) {
          return { viewer: null, alerts: [], errors: [errorMessage(error)], graphEmpty: [] };
        }
        const alerts: ReturnType<typeof parseDependabotAlerts> = [];
        const errors: string[] = [];
        const graphEmpty: string[] = [];
        for (const unit of units) {
          const repo = parseRepo(unit);
          if (repo === null) {
            errors.push(`${unit}: not owner/repo`);
            continue;
          }
          const name = `${repo.owner}/${repo.name}`;
          try {
            const seen = new Set<string>();
            let next: string | null = dependabotAlertsPath(name, state ?? "open");
            while (next !== null && !seen.has(next)) {
              seen.add(next);
              const page = await restPage(next, checkSignal());
              alerts.push(...parseDependabotAlerts(page.body, name));
              next = page.next;
            }
          } catch (error) {
            errors.push(`${unit}: ${errorMessage(error)}`);
          }
          try {
            if (parseDependencyGraphCount(await query(DEPENDENCY_GRAPH_QUERY, { ...repo }, checkSignal())) === 0) graphEmpty.push(name);
          } catch {
            // A read the token was refused is not an empty graph: leave the
            // repository unflagged rather than claim Dependabot can see nothing.
          }
        }
        return { viewer, alerts, errors, graphEmpty };
      },

      // A repository's recent deployments, newest first, read with the token
      // through the REST API (GraphQL does not expose deployments) and
      // filtered to the requested environment here: GitHub's `environment`
      // query is an exact match, while the playbook's environment and the
      // doorbell path match ignoring case. Each deployment's latest status is
      // its `state` and its `url`, as a `deployment` doorbell builds them; a
      // repository the token cannot read is named in `error` rather than
      // failing the call. Stewards uses this to confirm a merge carried by a
      // deployment that already exists, not only by a doorbell (BB-59).
      async sourceDeployments({ repo, environment, limit }) {
        const parsed = parseRepo(repo);
        if (parsed === null) return { deployments: [], error: `${repo}: not owner/repo` };
        const name = `${parsed.owner}/${parsed.name}`;
        try {
          const page = await restPage(deploymentsPath(name), checkSignal());
          const nodes = parseDeployments(page.body)
            .filter((d) => d.environment.toLowerCase() === environment.toLowerCase())
            .slice(0, limit);
          const deployments: Deployment[] = [];
          for (const node of nodes) {
            const status = parseDeploymentStatus((await restPage(deploymentStatusesPath(name, node.id), checkSignal())).body);
            deployments.push({
              id: node.id,
              environment: node.environment === "" ? environment : node.environment,
              ref: node.ref,
              sha: node.sha,
              state: status.state,
              url: status.url ?? node.url,
            });
          }
          return { deployments, error: null };
        } catch (error) {
          return { deployments: [], error: `${repo}: ${errorMessage(error)}` };
        }
      },

      // One file's text at a ref, for a deployment rule's `image-tag`
      // strategy: the manifest a newTag is read from and the Dockerfile a
      // consumer's pin is read from. A path not there at that ref is a null
      // content, not an error; a failed read is the error.
      async sourceFileAtRef({ repo, path, ref }) {
        const parsed = parseRepo(repo);
        if (parsed === null) return { content: null, error: `${repo}: not owner/repo` };
        try {
          const expression = `${ref}:${path}`;
          return { content: parseFileAtRef(await query(FILE_AT_REF_QUERY, { ...parsed, expression }, checkSignal())), error: null };
        } catch (error) {
          return { content: null, error: `${repo}: ${errorMessage(error)}` };
        }
      },

      // The newest commit on a branch touching a path at or before a time:
      // the build commit a deployment rule compares a merge against. An empty
      // path is the branch's tip as of that time ("HEAD" or empty is the
      // default branch).
      async sourceLatestCommit({ repo, branch, path, until }) {
        const parsed = parseRepo(repo);
        if (parsed === null) return { sha: null, committedAt: null, error: `${repo}: not owner/repo` };
        try {
          const qualified = branch === "" || branch.toUpperCase() === "HEAD" ? "refs/heads/HEAD" : `refs/heads/${branch}`;
          const commit = parseLatestCommit(await query(LATEST_COMMIT_QUERY, { ...parsed, qualified, path: path === "" ? null : path, until }, checkSignal()));
          return { sha: commit?.sha ?? null, committedAt: commit?.committedAt ?? null, error: null };
        } catch (error) {
          return { sha: null, committedAt: null, error: `${repo}: ${errorMessage(error)}` };
        }
      },

      // One workflow run by the workflow file and the run number an image tag
      // names, with its head sha, its start and its jobs. The REST API has no
      // lookup by run number, so the runs are paged newest first until the
      // number is reached or passed. A run that is not there is a null run.
      async sourceWorkflowRun({ repo, workflow, runNumber, runId }) {
        const parsed = parseRepo(repo);
        if (parsed === null) return { run: null, error: `${repo}: not owner/repo` };
        if (runId === undefined && (workflow === undefined || runNumber === undefined)) return { run: null, error: "name a run by runId, or by workflow and runNumber" };
        const name = `${parsed.owner}/${parsed.name}`;
        try {
          let found: ReturnType<typeof parseWorkflowRuns>[number] | null = null;
          if (runId !== undefined) {
            const body = (await restPage(workflowRunPath(name, runId), checkSignal())).body;
            found = parseWorkflowRuns({ workflow_runs: [body] })[0] ?? null;
          } else {
            for (let page = 1; page <= 20; page++) {
              const runs = parseWorkflowRuns((await restPage(workflowRunsPath(name, workflow!, page), checkSignal())).body);
              const match = runs.find((r) => r.runNumber === runNumber);
              if (match !== undefined) {
                found = match;
                break;
              }
              // Newest first: all below the wanted number means it is not here,
              // and a short page means there are no more.
              if (runs.length < 100 || runs.every((r) => r.runNumber < runNumber!)) break;
            }
          }
          if (found === null) return { run: null, error: null };
          const jobs = parseWorkflowJobs((await restPage(workflowRunJobsPath(name, found.id), checkSignal())).body);
          return { run: { id: found.id, runNumber: found.runNumber, headSha: found.headSha, startedAt: found.startedAt, jobs }, error: null };
        } catch (error) {
          return { run: null, error: `${repo}: ${errorMessage(error)}` };
        }
      },

      // GitHub's compare status of head against base, for a rule that asks
      // whether one ref contains another.
      async sourceCompare({ repo, base, head }) {
        const parsed = parseRepo(repo);
        if (parsed === null) return { status: null, error: `${repo}: not owner/repo` };
        try {
          const status = parseCompare((await restPage(comparePath(`${parsed.owner}/${parsed.name}`, base, head), checkSignal())).body);
          return { status, error: null };
        } catch (error) {
          return { status: null, error: `${repo}: ${errorMessage(error)}` };
        }
      },

      // Replaces the previous set. Anything new is leased right away; what
      // was dropped is simply not renewed and lapses within the hour.
      async sourceSetInterest({ units, entities, dependabot, deployment }, { experimental_caller: caller }) {
        if (caller.kind !== "plugin" || caller.pluginId !== STEWARDS_PLUGIN_ID) throw new Error(`sourceSetInterest is for the ${STEWARDS_PLUGIN_ID} plugin only`);
        const badUnits = units.filter((u) => parseRepo(u) === null);
        const badEntities = entities.filter((e) => parseRef(e) === null);
        const badDependabot = dependabot.filter((r) => parseRepo(r) === null);
        const badDeployment = deployment.filter((r) => parseRepo(r) === null);
        if (badUnits.length > 0 || badEntities.length > 0 || badDependabot.length > 0 || badDeployment.length > 0) {
          throw new Error(
            `not GitHub names: ${[
              ...badUnits.map((u) => `${JSON.stringify(u)} (want owner/repo)`),
              ...badEntities.map((e) => `${JSON.stringify(e)} (want owner/repo#12)`),
              ...badDependabot.map((r) => `${JSON.stringify(r)} (want owner/repo)`),
              ...badDeployment.map((r) => `${JSON.stringify(r)} (want owner/repo)`),
            ]
              .slice(0, 10)
              .join(", ")}`,
          );
        }
        const before = new Set(leases().map((l) => `${l.kind} ${l.id.toLowerCase()}`));
        const next: Interest = {
          units: [...new Set(units.map((u) => u.trim()))],
          entities: [...new Set(entities.map((e) => refKey(parseRef(e)!)))],
          dependabot: [...new Set(dependabot.map((r) => r.trim()))],
          deployment: [...new Set(deployment.map((r) => r.trim()))],
        };
        await bb.storage.kv.set(INTEREST_KEY, next);
        interest = next;
        interestRepos = new Set(next.units.map((u) => u.toLowerCase()));
        interestEntities = new Set(next.entities.map((e) => e.toLowerCase()));
        interestDependabot = new Set(next.dependabot.map((r) => r.toLowerCase()));
        interestDeployment = new Set(next.deployment.map((r) => r.toLowerCase()));
        announceWatches();
        const fresh = leases().filter((l) => !before.has(`${l.kind} ${l.id.toLowerCase()}`));
        const lease = (kind: Lease["kind"]) => {
          const ids = fresh.filter((l) => l.kind === kind).map((l) => l.id);
          if (ids.length > 0) hooks.added(kind, ...ids).catch((error: unknown) => bb.log.warn(`could not lease what stewards asked for right away: ${errorMessage(error)}`));
        };
        lease("repo");
        lease("issue");
        lease("dependabot_repo");
        lease("deployment_repo");
        // With no hooks service there is nothing to lease; wake the poller so
        // the new interest is read on the next round rather than at its timer.
        if (hooksUrl === "") poller.poke();
        return { ok: true };
      },
    });

    // `bb github-watcher watches` is the same view for a shell: a colleague's server,
    // or a script that wants to know what is being waited on.
    bb.cli.register(
      defineCli({
        name: "github-watcher",
        summary: "What this server's threads are watching on GitHub",
        description: "Runs on the bb server. Reads the plugin's own watch list; GitHub itself is read with gh.",
        commands: {
          watches: cliCommand({
            summary: "Every watch on this server, how busy each has been, what stewards has leased, and the doorbell stream's state",
            description:
              "The same view as Settings → Plugins → GitHub watcher → Watches. Flags: idle (old and not woken in days), noisy (woken often in the last hour), expiring (forgotten within a day unless something happens). With --json the output is the full view object.",
            options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
            async run(input) {
              const view = await usage();
              return { exitCode: 0, stdout: input.options.json ? JSON.stringify(view) : formatUsage(view) };
            },
          }),
        },
      }),
    );

    if (hooksUrl !== "") {
      // The stream is held whether or not gh is signed in: a lease is only
      // asked for when a watch exists, and a watch is only added after a
      // read with the token worked. Without watches the stream is idle.
      bb.background.service("watches", {
        async start(signal) {
          await hooks.run(signal);
        },
      });
    } else {
      // No hooks service: the same watches and stewards interest are re-read
      // on a plain timer. `github_watch` and the stewards setting both name
      // the interval; the usage view shows the poller's state.
      bb.background.service("watches", {
        async start(signal) {
          await poller.run(signal);
        },
      });
    }

    const forgetThread = (threadId: string) => {
      const removed = watches.removeThread(threadId);
      if (removed > 0) {
        bb.log.info(`thread ${threadId} is gone; forgot its ${removed} GitHub watch${removed === 1 ? "" : "es"}`);
        announceWatches();
      }
    };
    bb.events.on("thread.archived", ({ thread }) => forgetThread(thread.id));
    bb.events.on("thread.deleted", ({ thread }) => forgetThread(thread.id));

    const toolError = (error: unknown) => ({ content: [{ type: "text" as const, text: errorMessage(error) }], isError: true });

    bb.agents.registerTool({
      name: "github_watch",
      description:
        "Watch a GitHub pull request or issue from this thread: when it is merged, closed or reopened, when a review is submitted or requested, when its checks finish or fail, when an open head has had no checks for a while, when commits are pushed, when labels, assignees or title change, or when someone else comments, this thread is sent a message describing the change (which starts a new turn if the thread is idle). Use it when there is nothing to do until the PR or issue moves, then end the turn instead of polling. A thread can watch up to 10; a watch nobody has woken in a week is dropped.",
      instructions:
        "This bb server is signed in to GitHub as the user; use gh on the machine for reading and writing GitHub. When nothing can be done until a pull request or issue changes (a review you asked for, checks you are waiting on, a question you asked in a comment), call github_watch with its URL or owner/repo#number and end the turn rather than polling: the thread is messaged when it changes. A step that waits mid-flow — checks after a push, a reviewer's verdict — may span a turn boundary: the wake carries the changed fields, including the checks rollup and the failing check names, so the step resumes from it with nothing lost. Do not hold the turn in a sleep loop over gh pr checks or gh pr view, and do not run gh pr checks --watch, when this tool is present.",
      presentation: { label: { pending: "Watching on GitHub", completed: "Watching on GitHub" } },
      parameters: z.object({ ref: refInput }),
      async execute({ ref: input }, { threadId, projectId, signal }) {
        const ref = parseRef(input);
        if (ref === null) return toolError(new Error(`${JSON.stringify(input)} does not name a pull request or issue. Give its URL, owner/repo#12, or owner/repo/pull/12.`));
        try {
          const target = await readTarget(ref, signal);
          if (target === null) return toolError(new Error(`No ${ref.repo}#${ref.number} on GitHub, or it is not visible to the signed-in user.`));
          const added = watches.add({
            threadId,
            projectId,
            key: target.key,
            kind: target.kind,
            snapshot: snapshotOf(target),
            noChecksSince: initialNoChecks(target, deps.now()),
            noChecksWoken: null,
            ...initialCursors(target, new Date(deps.now()).toISOString()),
          });
          const what = `${kindName(target.kind)} ${target.key}: ${target.title ?? "(untitled)"}`;
          if (added.outcome === "full") {
            return toolError(new Error(`This thread already watches ${added.limit} GitHub pull requests or issues, the most it can. It is still watching them; it cannot add ${target.key}.`));
          }
          if (added.outcome === "already") return `Already watching ${what}. This thread will be messaged when it changes; you can end the turn.`;
          announceWatches();
          scheduleNoChecks(target.key);
          if (hooksUrl === "") {
            // No hooks service: the watch is picked up by the poller's next
            // round. Poke it so a watch added just after a poll is not left
            // for the whole interval.
            poller.poke();
            const minutes = Math.max(1, Math.round(poller.intervalMs / 60_000));
            return `Watching ${what}. This thread will be messaged when it changes or someone else comments; this server polls every ${minutes} minutes (no hooks service configured). End the turn rather than polling.`;
          }
          // Not awaited: the lease lands within seconds when the stream is up,
          // and the next hello covers it when it is not. The tool need not wait.
          hooks.added("issue", target.key).catch((error: unknown) => bb.log.warn(`could not lease ${target.key} right away: ${errorMessage(error)}`));
          return `Watching ${what}. This thread will be messaged when it changes or someone else comments; end the turn rather than polling.`;
        } catch (error) {
          return toolError(error);
        }
      },
    });

  };
}

export default createGitHubPlugin({ fetch: (url, init) => fetch(url, init), now: () => Date.now(), env: process.env, token: createGhTokenReader() });
