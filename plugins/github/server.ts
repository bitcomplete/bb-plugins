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
// machine. What `gh` cannot do is wake a thread later, and that is the whole
// of this plugin: a watch (watch.ts) is a row in the plugin's SQLite plus a
// lease on bb-gate-hooks (hooks-client.ts); when GitHub's webhook rings, the
// target is re-read here and the thread is messaged with what changed.
import { cliCommand, defineCli, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { WATCHES_CHANGED } from "./channels.js";
import { createGhTokenReader, type TokenReader } from "./gh.js";
import { GITHUB_API_URL, GitHubRequestError, TARGET_QUERY, graphql, kindName, parseRef, parseRefKey, parseTarget, type Target } from "./github.js";
import { createHooksLoop, HOOKS_URL_ENV, type Rejection } from "./hooks-client.js";
import { buildUsage, formatUsage, usageViewSchema } from "./usage.js";
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
});
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

    // ---- reading a target ---------------------------------------------------

    /** The target as the developer, or null when it does not exist or is not visible. A 401 re-reads the token once. */
    async function readTarget(ref: { repo: string; number: number }, signal: AbortSignal): Promise<Target | null> {
      const [owner, name] = ref.repo.split("/") as [string, string];
      const variables = { owner, name, number: ref.number };
      let payload: unknown;
      try {
        payload = await graphql(apiUrl, await accessToken(), TARGET_QUERY, variables, deps.fetch, signal);
      } catch (error) {
        if (!(error instanceof GitHubRequestError && error.status === 401)) throw error;
        payload = await graphql(apiUrl, await refreshToken("GitHub answered 401"), TARGET_QUERY, variables, deps.fetch, signal);
      }
      return parseTarget(payload);
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

    // The service refusing a lease is not proof the developer lost access:
    // with GitHub rate-limiting the service, or briefly down, every watch
    // would come back `forbidden`. The developer's own read is the ground
    // truth, so a refused target is read here before the thread is told it
    // is gone; one that reads fine keeps its watch and is leased again at
    // the next renewal.
    async function onRejected(rejected: Rejection[]): Promise<void> {
      for (const r of rejected) {
        if (r.kind !== "issue" || r.reason !== "forbidden") continue;
        const watching = watches.forKey(r.id);
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
      watchIds: () => watches.keys(),
      onDoorbell: (key) => checks.ring(key),
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
      });
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
    });

    // `bb github watches` is the same view for a shell: a colleague's server,
    // or a script that wants to know what is being waited on.
    bb.cli.register(
      defineCli({
        name: "github",
        summary: "What this server's threads are watching on GitHub",
        description: "Runs on the bb server. Reads the plugin's own watch list; GitHub itself is read with gh.",
        commands: {
          watches: cliCommand({
            summary: "Every watch on this server, how busy each has been, and the doorbell stream's state",
            description:
              "The same view as Settings → Plugins → GitHub → Watches. Flags: idle (old and not woken in days), noisy (woken often in the last hour), expiring (forgotten within a day unless something happens). With --json the output is the full view object.",
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
          hooks.added(target.key).catch((error: unknown) => bb.log.warn(`could not lease ${target.key} right away: ${errorMessage(error)}`));
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
