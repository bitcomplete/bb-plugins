// GitHub: let a thread watch a pull request or issue and be woken when it
// changes, as the developer.
//
// There is no connect step of its own. Team setup signs `gh` in on this
// server host, bb core forwards that login to every machine, and this
// plugin reads the same token with `gh auth token` whenever it needs one:
// to read the target as the developer, and to prove each watch to
// bb-gate-hooks. A thread sees results, never the token.
//
// Everything else a thread wants from GitHub it does with `gh` on its
// machine. What `gh` cannot do is wake a thread later, and that is the heart
// of this plugin: a watch (watch.ts) is a row in the plugin's SQLite plus a
// lease on bb-gate-hooks (hooks-client.ts); when GitHub's webhook rings, the
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
  GITHUB_API_URL,
  GitHubRequestError,
  OPEN_PULLS_QUERY,
  REPO_CHECK_QUERY,
  TARGET_QUERY,
  VIEWER_QUERY,
  dependabotAlertsPath,
  deploymentStatusesPath,
  deploymentsPath,
  graphql,
  kindName,
  parseDependabotAlerts,
  parseDeploymentStatus,
  parseDeployments,
  parseOpenPulls,
  parseRef,
  parseRefKey,
  parseRepo,
  parseRepoCheck,
  parseSnapshot,
  parseTarget,
  parseViewer,
  refKey,
  type Target,
} from "./github.js";
import { createHooksLoop, HOOKS_URL_ENV, type Lease, type Rejection } from "./hooks-client.js";
import { deploymentSchema, ringStewards, sourceContract, STEWARDS_PLUGIN_ID, type AdoptableEntity, type Deployment } from "./source-contract.js";
import { buildUsage, createRefusals, formatUsage, usageViewSchema, type InterestView } from "./usage.js";
import { compare, createCheckQueue, createWatchStore, initialCursors, snapshotOf, WATCH_MIGRATIONS, type WatchRow } from "./watch.js";

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
const interestSchema = z.object({ units: z.array(z.string()), entities: z.array(z.string()), dependabot: z.array(z.string()).default([]), deployment: z.array(z.string()).default([]) });
type Interest = z.infer<typeof interestSchema>;

/** How long a token read from gh is reused before gh is asked again. */
export const TOKEN_CACHE_MS = 5 * 60 * 1000;

export interface GitHubPluginDeps {
  fetch: typeof fetch;
  now: () => number;
  env: Record<string, string | undefined>;
  /** The developer's token, from gh on this host. */
  token: TokenReader;
  /** Where GraphQL is sent; GITHUB_API_URL unless a test says otherwise. */
  apiUrl?: string;
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

    /** The target's one read, unparsed: a watch and stewards' snapshot read the same answer two ways. */
    function readTargetPayload(ref: { repo: string; number: number }, signal: AbortSignal): Promise<unknown> {
      const [owner, name] = ref.repo.split("/") as [string, string];
      return query(TARGET_QUERY, { owner, name, number: ref.number }, signal);
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
      if (watching.length === 0) return;
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
        const outcome = compare(watch, target);
        if (outcome.message === null) {
          watches.advance(watch.threadId, watch.key, outcome, false);
          continue;
        }
        const sent = await wake(watch.threadId, outcome.message);
        if (sent === "gone") watches.remove(watch.threadId, watch.key);
        else if (sent === "sent") watches.advance(watch.threadId, watch.key, outcome, true);
        if (sent !== "failed") announceWatches();
      }
    }

    const checks = createCheckQueue(checkKey, { onError: (key, error) => bb.log.warn(`GitHub watch check of ${key} failed: ${errorMessage(error)}`) });
    bb.onDispose(() => checks.stop());

    async function sweep(reason: string): Promise<void> {
      const expired = watches.expire();
      if (expired > 0) {
        bb.log.info(`forgot ${expired} GitHub watch${expired === 1 ? "" : "es"} idle for a week`);
        announceWatches();
      }
      const keys = watches.keys();
      if (keys.length > 0) bb.log.info(`checking ${keys.length} watched GitHub pull request${keys.length === 1 ? "" : "s"} or issue${keys.length === 1 ? "" : "s"} (${reason})`);
      await checks.sweep(keys);
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
    /** Stewards' leases bb-gate-hooks refused, by `<kind> <lowercased id>`. */
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
      if (kind === "deployment") return repo !== null && interestDeployment.has(repo.toLowerCase());
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
          if (interestDependabot.has(r.id.toLowerCase())) bb.log.info(`bb-gate-hooks refused a dependabot_repo lease on ${r.id} (${r.reason}); this server skips Dependabot alerts there`);
          continue;
        }
        if (r.kind === "deployment_repo") {
          // Reading a repository's deployments needs `deployments:read` (or
          // the `repo` scope); a token without it is refused here, which is a
          // skip: the server keeps running without deployment doorbells.
          if (interestDeployment.has(r.id.toLowerCase())) bb.log.info(`bb-gate-hooks refused a deployment_repo lease on ${r.id} (${r.reason}); this server skips deployment doorbells there`);
          continue;
        }
        if (r.kind === "repo" || (watching.length === 0 && interestEntities.has(r.id.toLowerCase()))) {
          bb.log.warn(`bb-gate-hooks refused a lease on ${r.kind === "repo" ? `repository ${r.id}` : r.id} for stewards (${r.reason}); stewards will not be rung for it`);
          continue;
        }
        if (r.kind !== "issue" || r.reason !== "forbidden") continue;
        if (watching.length === 0) continue;
        const ref = parseRefKey(r.id);
        try {
          if (ref !== null && (await readTarget(ref, checkSignal())) !== null) {
            bb.log.warn(`bb-gate-hooks refused a lease on ${r.id} that the signed-in user can read; keeping the watch`);
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
      refreshToken: () => refreshToken("was refused by bb-gate-hooks"),
      watchIds: leases,
      onDoorbell: (kind, key, unit, deployment) => {
        if (kind === "issue") checks.ring(key);
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

    /** Stewards' interest as a person reads it, with whatever bb-gate-hooks refused of it. */
    function interestView(): InterestView {
      const refused = refusals.current();
      const unleased: InterestView["unleased"] = [];
      for (const repo of interest.units) {
        const reason = refused.get(`repo ${repo.toLowerCase()}`);
        if (reason !== undefined) unleased.push({ key: repo, reason: `refused by bb-gate-hooks (${reason})` });
      }
      for (const key of interest.entities) {
        const reason = refused.get(`issue ${key.toLowerCase()}`);
        if (reason !== undefined) unleased.push({ key, reason: `refused by bb-gate-hooks (${reason})` });
      }
      for (const repo of interest.dependabot) {
        const reason = refused.get(`dependabot_repo ${repo.toLowerCase()}`);
        if (reason !== undefined) unleased.push({ key: repo, reason: `refused by bb-gate-hooks (${reason}); Dependabot alerts are skipped` });
      }
      for (const repo of interest.deployment) {
        const reason = refused.get(`deployment_repo ${repo.toLowerCase()}`);
        if (reason !== undefined) unleased.push({ key: repo, reason: `refused by bb-gate-hooks (${reason}); deployment doorbells are skipped` });
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
        return { snapshot: parseSnapshot(await readTargetPayload(ref, checkSignal())) };
      },

      // States are Linear's; GitHub has none to check. A gh that is not
      // signed in is an answer here (`error`), not a failure: it is the
      // first thing `bb stewards check` should say.
      async sourceValidate({ units, label }) {
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
            const found = repo === null ? { found: false, labelFound: false } : parseRepoCheck(await query(REPO_CHECK_QUERY, { ...repo, label }, checkSignal()));
            checked.push({ unit, found: found.found, labelFound: found.labelFound, missingStates: [] });
          }
        } catch (error) {
          return { viewer, units: [], mine: [], error: errorMessage(error) };
        }
        return { viewer, units: checked, mine: [], error: null };
      },

      // Each repository is read oldest first up to the limit, so the oldest
      // `limit` across all of them are among what was read.
      async sourceAdoptable({ units, limit }) {
        let viewer: string;
        try {
          viewer = parseViewer(await query(VIEWER_QUERY, {}, checkSignal()));
        } catch (error) {
          return { viewer: null, entities: [], errors: [errorMessage(error)] };
        }
        const entities: AdoptableEntity[] = [];
        const errors: string[] = [];
        for (const unit of units) {
          const repo = parseRepo(unit);
          if (repo === null) {
            errors.push(`${unit}: not owner/repo`);
            continue;
          }
          try {
            let after: string | null = null;
            let read = 0;
            do {
              const page = parseOpenPulls(await query(OPEN_PULLS_QUERY, { ...repo, first: Math.min(100, limit - read), after }, checkSignal()));
              if (page === null) {
                errors.push(`${unit}: no such repository, or it is not visible to the signed-in GitHub user`);
                break;
              }
              entities.push(...page.entities);
              read += page.entities.length;
              after = page.next;
            } while (after !== null && read < limit);
          } catch (error) {
            errors.push(`${unit}: ${errorMessage(error)}`);
          }
        }
        entities.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
        return { viewer, entities: entities.slice(0, limit), errors };
      },

      // A repository's Dependabot alerts, read with the token through the
      // REST API. Each repository the token cannot read (no alert access,
      // alerts disabled, not visible) is named in `errors`; the rest are
      // still returned. Reading alerts needs more than read access to the
      // repository (bb-gate/docs/hooks.md, "Admission, alerts").
      async sourceDependabotAlerts({ units, state }) {
        let viewer: string;
        try {
          viewer = parseViewer(await query(VIEWER_QUERY, {}, checkSignal()));
        } catch (error) {
          return { viewer: null, alerts: [], errors: [errorMessage(error)] };
        }
        const alerts: ReturnType<typeof parseDependabotAlerts> = [];
        const errors: string[] = [];
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
        }
        return { viewer, alerts, errors };
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
        "Watch a GitHub pull request or issue from this thread: when it is merged, closed or reopened, when a review is submitted or requested, when its checks finish or fail, when commits are pushed, when labels, assignees or title change, or when someone else comments, this thread is sent a message describing the change (which starts a new turn if the thread is idle). Use it when there is nothing to do until the PR or issue moves, then end the turn instead of polling. A thread can watch up to 10; a watch nobody has woken in a week is dropped.",
      instructions:
        "This bb server is signed in to GitHub as the user; use gh on the machine for reading and writing GitHub. When nothing can be done until a pull request or issue changes (a review you asked for, checks you are waiting on, a question you asked in a comment), call github_watch with its URL or owner/repo#number and end the turn rather than polling: the thread is messaged when it changes.",
      presentation: { label: { pending: "Watching on GitHub", completed: "Watching on GitHub" } },
      parameters: z.object({ ref: refInput }),
      async execute({ ref: input }, { threadId, projectId, signal }) {
        if (hooksUrl === "") {
          return toolError(new Error("Watching GitHub pull requests and issues is not available on this bb server: it has no bb-gate-hooks service (BB_HOOKS_URL is not set). Check it again later with gh instead."));
        }
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
            ...initialCursors(target, new Date(deps.now()).toISOString()),
          });
          const what = `${kindName(target.kind)} ${target.key}: ${target.title ?? "(untitled)"}`;
          if (added.outcome === "full") {
            return toolError(new Error(`This thread already watches ${added.limit} GitHub pull requests or issues, the most it can. It is still watching them; it cannot add ${target.key}.`));
          }
          if (added.outcome === "already") return `Already watching ${what}. This thread will be messaged when it changes; you can end the turn.`;
          // Not awaited: the lease lands within seconds when the stream is up,
          // and the next hello covers it when it is not. The tool need not wait.
          hooks.added("issue", target.key).catch((error: unknown) => bb.log.warn(`could not lease ${target.key} right away: ${errorMessage(error)}`));
          announceWatches();
          return `Watching ${what}. This thread will be messaged when it changes or someone else comments; end the turn rather than polling.`;
        } catch (error) {
          return toolError(error);
        }
      },
    });

  };
}

export default createGitHubPlugin({ fetch: (url, init) => fetch(url, init), now: () => Date.now(), env: process.env, token: createGhTokenReader() });
