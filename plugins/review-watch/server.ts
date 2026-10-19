// review-watch — a personal GitHub review inbox.
//
// A background service asks GitHub what needs the operator's attention, stores
// a deduplicated queue in one bb.storage.kv value, and surfaces it on the
// Reviews page (app.tsx, over RPC) and through `bb review-watch`.
//
// The queue is notify-only. Nothing here posts to GitHub, and nothing here
// spawns a thread on its own: `start` is the only side effect, and only a
// human (or an agent acting for one) reaches it. That restraint is the point —
// a watcher that dispatches by itself cannot be trusted to watch.
import {
  defineRpcContract,
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  createGhTransport,
  createGithubClient,
  createTokenTransport,
  isTransportConfigurationError,
  type GhTransport,
  type GithubClient,
  type GraphqlTransport,
} from "./src/github.js";
import { classify, mergeQueue } from "./src/rules.js";
import {
  queueItemSchema,
  ruleSchema,
  type QueueItem,
  type Rule,
} from "./src/types.js";

const CONFIGURE_HINT =
  "Set project with `bb plugin config review-watch`, and authenticate to GitHub " +
  "either by setting githubToken or by running `gh auth login` on this host, " +
  "then `bb plugin reload review-watch`.";

const QUEUE_KEY = "queue";
const LAST_POLL_KEY = "last-poll";

/** Realtime channel app.tsx listens on; the payload is the queued count. */
const QUEUE_CHANGED = "queue-changed";

/** Headings, in the order a human should work them. */
const RULE_LABELS: Record<Rule, string> = {
  "review-requested": "Needs your review",
  "review-followup": "Needs a follow-up",
};

/** Leaves room for the JSON envelope the host wraps CLI output in. */
const CLI_OUTPUT_BUDGET = PLUGIN_CLI_OUTPUT_MAX_BYTES - 4096;

interface PassResult {
  /** False when the pass could not run: the transport or GitHub failed. */
  ok: boolean;
  /** Items that became `queued` on this pass and were not in the queue before. */
  added: number;
  /** Items the merge dropped — closed, merged, or aged out. */
  removed: number;
  total: number;
  changed: boolean;
  error?: string;
}

interface LastPoll {
  at: string;
  ok: boolean;
  added: number;
  total: number;
  error?: string;
}

/** Which route the poller reads GitHub through. */
type TransportKind = "token" | "gh";

type Lookup =
  | { ok: true; item: QueueItem }
  | { ok: false; message: string };

/** Comma-separated `owner/name` entries; empty means every repo. */
function parseAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Sleeps, but wakes at once on abort. A plain setTimeout sleeps through the
 * stop window and the plugin reports "degraded (service did not stop)".
 */
function sleepUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Truncates to the host's CLI output limit. The host rejects an over-limit
 * result whole rather than clipping it, so a long queue must be cut here.
 */
function clampOutput(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= CLI_OUTPUT_BUDGET) return text;
  const notice = "\n… output truncated; narrow it with --rule or use --json.";
  const room = CLI_OUTPUT_BUDGET - Buffer.byteLength(notice, "utf8");
  return `${Buffer.from(text, "utf8").subarray(0, room).toString("utf8")}${notice}`;
}

function relativeAge(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

// ---------------------------------------------------------------------------
// Prompt templates. One per rule, short and specific, with the item
// interpolated. Both forbid writing to GitHub — the plugin presents, the
// human posts.
// ---------------------------------------------------------------------------

function prSummary(item: QueueItem): string {
  return item.title.trim().split(/\s+/).slice(0, 8).join(" ");
}

const reviewPrompt = (item: QueueItem): string =>
  [
    `Review the pull request ${item.repo}#${item.number} (${prSummary(item)}) by @${item.author}.`,
    `Full title: ${item.title}`,
    `URL: ${item.url}`,
    `Branch ${item.headBranch} at ${item.headSha} onto ${item.baseBranch}.`,
    `Use \`gh pr diff ${item.number} -R ${item.repo}\` and \`gh pr view ${item.number} -R ${item.repo}\` to inspect the complete current diff, review history, CI, and mergeability. Fetch review threads with \`gh api\` where needed.`,
    "",
    "1. Read the full diff against the base branch and all relevant review context.",
    "2. If a matching local checkout exists, use it for deeper checks and relevant tests. Run the repository's review skill or `/code-review` command when available.",
    "3. Present your findings in this thread, ordered by severity, each with a file and line.",
    "",
    "Do not submit a GitHub review, approve, request changes, or post a comment. The human posts; you draft.",
  ].join("\n");

// The queue item carries no previously-reviewed commit — `QueueItem` has no
// field for one — so the agent resolves it from the pull request itself rather
// than the prompt naming a sha review-watch cannot know.
const reviewFollowupPrompt = (item: QueueItem): string =>
  [
    `Re-review the pull request ${item.repo}#${item.number} (${prSummary(item)}) by @${item.author}.`,
    `Full title: ${item.title}`,
    `URL: ${item.url}`,
    `You reviewed an earlier commit; the head is now ${item.headSha} on ${item.headBranch}.`,
    `Use \`gh pr diff ${item.number} -R ${item.repo}\`, \`gh pr view ${item.number} -R ${item.repo}\`, and \`gh api\` to inspect the current diff, prior review, review threads, CI, and mergeability.`,
    "",
    "1. Find your own most recent review on the pull request and the commit it was submitted against.",
    `2. Diff that commit against ${item.headSha} and focus only on what changed since.`,
    "3. Say which of your earlier findings the new commits address and which they do not.",
    "4. If a matching local checkout exists, use it for deeper checks and relevant tests. Run the repository's review skill or `/code-review` command over the new range when available.",
    "5. Present your findings in this thread.",
    "",
    "Do not submit a GitHub review, approve, request changes, or post a comment. The human posts; you draft.",
  ].join("\n");

function promptFor(item: QueueItem): string {
  switch (item.rule) {
    case "review-requested":
      return reviewPrompt(item);
    case "review-followup":
      return reviewFollowupPrompt(item);
  }
}

function batchPrompt(items: QueueItem[]): string {
  return [
    "Review these pull requests together from the configured project's default environment. Use `gh` to inspect every pull request, even when its repository has no local checkout.",
    ...items.flatMap((item) => [
      "",
      `- ${item.repo}#${item.number} (${prSummary(item)}): ${item.url}`,
      `  Full title: ${item.title}`,
      `  Head: ${item.headSha}; rule: ${item.rule}; branch: ${item.headBranch} onto ${item.baseBranch}.`,
    ]),
    "",
    "For each pull request, use `gh pr diff` and `gh pr view` with its repository and number. Use `gh api` as needed for complete review threads, prior reviews, CI, and mergeability. If a matching local checkout exists, run deeper checks and relevant tests there. Use the repository's review skill or `/code-review` command when available.",
    "Report one batch priority overview. Then, for each pull request, report:",
    "- Purpose: what the change does.",
    "- State: head commit, CI, mergeability, and prior reviews.",
    "- Findings: ordered by severity, with file:line evidence.",
    "- Next: approve, approve with explicit required before-merge changes, request changes, or defer. Approval does not enforce the required changes; name who must verify them before merge.",
    "Call out coverage gaps and dependencies between pull requests.",
    "Do not post GitHub reviews or comments, approve or request changes on GitHub, or push code. Report in this thread for the human to act on.",
  ].join("\n");
}

// Both schemas run at the wire boundary. Handler input/output are inferred
// from the shared contract; app.tsx imports only its type.
export const rpcContract = defineRpcContract({
  queue_list: {
    input: z.null(),
    output: z.object({
      items: z.array(queueItemSchema),
      lastPoll: z
        .object({
          at: z.string(),
          ok: z.boolean(),
          added: z.number(),
          total: z.number(),
          error: z.string().optional(),
        })
        .nullable(),
    }),
  },
  item_start: {
    input: z.object({ key: z.string().min(1) }),
    output: z.object({ item: queueItemSchema }),
  },
  item_batch_start: {
    input: z.object({ keys: z.array(z.string().min(1)).min(1) }),
    output: z.object({ threadId: z.string(), items: z.array(queueItemSchema) }),
  },
  item_dismiss: {
    input: z.object({ key: z.string().min(1) }),
    output: z.object({ item: queueItemSchema }),
  },
  poll_now: {
    input: z.null(),
    output: z.object({
      ok: z.boolean(),
      added: z.number(),
      removed: z.number(),
      total: z.number(),
      changed: z.boolean(),
      error: z.string().optional(),
    }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    githubToken: {
      type: "string",
      label: "GitHub personal access token",
      description:
        "Optional. A PAT with `repo` scope; leave it empty to read GitHub through " +
        "an authenticated `gh` CLI on this host. Read-only either way: " +
        "review-watch never writes to GitHub.",
      secret: true,
    },
    pollMinutes: {
      type: "number",
      label: "Poll interval (minutes)",
      description: "How often to ask GitHub what needs your attention.",
      default: 5,
    },
    repoAllowlist: {
      type: "string",
      label: "Repository allowlist",
      description: "Comma-separated `owner/name` entries. Empty watches every repository.",
      default: "",
    },
    project: {
      type: "project",
      label: "BB project",
      description: "Project a started review runs in.",
    },
    provider: {
      type: "string",
      label: "Provider id",
      description: "Optional. Passed through when a review thread spawns.",
    },
    model: {
      type: "string",
      label: "Model id",
      description: "Optional. Passed through when a review thread spawns.",
    },
    maxAgeDays: {
      type: "number",
      label: "Drop items older than (days)",
      description: "An item this old leaves the queue even if GitHub still lists it.",
      default: 14,
    },
  });

  /**
   * Settings snapshot. Writes do not reload the plugin, so the poller reads
   * this rather than values captured once at load.
   */
  let current = await settings.get();
  let allowlist = parseAllowlist(current.repoAllowlist);
  /** Resolved once per token: the login every rule is judged against. */
  let cachedLogin: string | null = null;

  settings.onChange((next) => {
    if (next.githubToken !== current.githubToken) cachedLogin = null;
    current = next;
    allowlist = parseAllowlist(next.repoAllowlist);
  });

  // Only the project can be judged here. Neither transport can: an empty token
  // is a valid configuration when `gh` is authenticated, and the `gh` binary is
  // probed on first use, so the first poll is the earliest honest verdict.
  if (!current.project) {
    bb.status.needsConfiguration(CONFIGURE_HINT);
  }

  // -------------------------------------------------------------------------
  // Storage. The whole queue is one JSON array: it holds tens of items, well
  // inside the 256KB value limit, and a single value keeps merges atomic.
  // -------------------------------------------------------------------------

  /**
   * Rows of a rule this plugin no longer queues — `feedback-to-address`, which
   * Workstreams now owns — are skipped here and vanish at the next write.
   */
  async function readQueue(): Promise<QueueItem[]> {
    const stored = (await bb.storage.kv.get<QueueItem[]>(QUEUE_KEY)) ?? [];
    return stored.filter((item) => ruleSchema.safeParse(item.rule).success);
  }

  async function writeQueue(items: QueueItem[]): Promise<void> {
    await bb.storage.kv.set(QUEUE_KEY, items);
    bb.realtime.publish(QUEUE_CHANGED, {
      queued: items.filter((item) => item.state === "queued").length,
      pending: items.filter((item) => item.state === "queued" || item.state === "started").length,
    });
  }

  // Serialize read/modify/write cycles, including thread spawns. A poll can
  // fetch GitHub outside this lock, then merge against the latest queue.
  let queueTurn: Promise<void> = Promise.resolve();
  async function withQueueLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queueTurn;
    let release!: () => void;
    queueTurn = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function readLastPoll(): Promise<LastPoll | null> {
    return (await bb.storage.kv.get<LastPoll>(LAST_POLL_KEY)) ?? null;
  }

  /** Everything a human still has to act on. Dismissed rows stay stored but hidden. */
  async function visibleQueue(): Promise<QueueItem[]> {
    const items = await readQueue();
    return items
      .filter((item) => item.state !== "dismissed")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * Keys carry a 40-character sha and are unpleasant to type, so any surface
   * that takes a key takes an unambiguous prefix too.
   */
  function lookup(items: QueueItem[], key: string): Lookup {
    const exact = items.find((item) => item.key === key);
    if (exact !== undefined) return { ok: true, item: exact };
    const matches = items.filter((item) => item.key.startsWith(key));
    if (matches.length === 1) return { ok: true, item: matches[0]! };
    if (matches.length === 0) {
      return { ok: false, message: `No queue item matches ${key}.` };
    }
    return {
      ok: false,
      message: `${matches.length} queue items match ${key}; use a longer prefix.`,
    };
  }

  // -------------------------------------------------------------------------
  // Polling.
  // -------------------------------------------------------------------------

  /**
   * The token as a transport wants it: trimmed, and absent rather than empty, so
   * a whitespace-only setting falls through to `gh` instead of being offered to
   * GitHub as a credential.
   */
  function configuredToken(): string | undefined {
    const token = current.githubToken?.trim();
    return token === undefined || token === "" ? undefined : token;
  }

  /**
   * The whole transport decision, read from the current settings snapshot and
   * kept pure, so `status` can report the route without building a transport.
   */
  function transportKind(): TransportKind {
    return configuredToken() === undefined ? "gh" : "token";
  }

  /**
   * Built once and reused across passes: `createGhTransport` resolves the `gh`
   * binary on first use and caches it, and a per-pass transport would re-probe
   * the filesystem every few minutes.
   */
  let ghTransport: GhTransport | null = null;
  /** Rebuilt when the token setting changes, since the token is baked in. */
  let tokenTransport: { token: string; transport: GraphqlTransport } | null = null;

  /** The transport for this pass, built or reused per the current settings. */
  function selectTransport(): GraphqlTransport {
    const token = configuredToken();
    if (token === undefined) {
      ghTransport ??= createGhTransport();
      return ghTransport;
    }
    if (tokenTransport === null || tokenTransport.token !== token) {
      tokenTransport = { token, transport: createTokenTransport({ token }) };
    }
    return tokenTransport.transport;
  }

  /** The `gh` binary a poll resolved, or undefined before the first poll. */
  function ghBinaryPath(): string | undefined {
    return ghTransport?.resolvedPath();
  }

  function client(transport: GraphqlTransport): GithubClient {
    return createGithubClient({ transport });
  }

  async function login(github: GithubClient): Promise<string> {
    if (cachedLogin === null) cachedLogin = await github.viewerLogin();
    return cachedLogin;
  }

  async function runPass(): Promise<PassResult> {
    return withQueueLock(async () => {
      const github = client(selectTransport());
      const viewer = await login(github);
      const now = new Date().toISOString();
      // Search one complete UTC day beyond the queue's age window so the
      // date-only GitHub qualifier cannot exclude a still-eligible item.
      const updatedSince = new Date(
        Date.parse(now) - (current.maxAgeDays + 1) * 86_400_000,
      ).toISOString().slice(0, 10);
      const pullRequests = await github.fetchWatchedPullRequests(viewer, updatedSince);
      const incoming = classify(pullRequests, {
        login: viewer,
        repoAllowlist: allowlist,
        now,
      });
      const existing = await readQueue();
      const openNodeIds = new Set(pullRequests.map((pr) => pr.nodeId));
      const retainedStartedIds = [...new Set(existing
        .filter((item) => item.state === "started" && !openNodeIds.has(item.nodeId))
        .map((item) => item.nodeId))];
      const retained = await github.fetchRetainedPullRequests(retainedStartedIds, viewer);
      for (const id of retained.openNodeIds) openNodeIds.add(id);
      const retainedDismissedIds = [...new Set(existing
        .filter((item) => item.state === "dismissed" && !openNodeIds.has(item.nodeId))
        .map((item) => item.nodeId))];
      for (const id of await github.fetchOpenNodeIds(retainedDismissedIds)) openNodeIds.add(id);
      const merged = mergeQueue(existing, incoming, {
        openNodeIds,
        observedPullRequests: [...pullRequests, ...retained.pullRequests],
        maxAgeDays: current.maxAgeDays,
        now,
      });

      const before = new Set(existing.map((item) => item.key));
      const after = new Set(merged.map((item) => item.key));
      const added = merged.filter(
        (item) => item.state === "queued" && !before.has(item.key),
      ).length;
      const removed = existing.filter((item) => !after.has(item.key)).length;
      const changed = JSON.stringify(existing) !== JSON.stringify(merged);
      if (changed) await writeQueue(merged);

      return { ok: true, added, removed, total: merged.length, changed };
    });
  }

  /** Never throws: a GitHub error must not end the service. */
  async function pollOnce(): Promise<PassResult> {
    let result: PassResult;
    try {
      result = await runPass();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      bb.log.warn(`poll failed: ${error}`);
      // The transport is the one failure a human must fix, and it cannot be
      // caught at load: `gh` is resolved on first use. Report the transport's
      // own message, which names the fix — a missing `gh` points at the
      // githubToken setting, an unauthenticated one at `gh auth refresh`.
      if (isTransportConfigurationError(cause)) {
        bb.status.needsConfiguration(error);
      }
      result = {
        ok: false,
        added: 0,
        removed: 0,
        total: (await readQueue()).length,
        changed: false,
        error,
      };
    }
    const record: LastPoll = {
      at: new Date().toISOString(),
      ok: result.ok,
      added: result.added,
      total: result.total,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
    await bb.storage.kv.set(LAST_POLL_KEY, record);
    if (result.ok && result.added > 0) {
      // The realtime signal and the sidebar badge are the whole notification:
      // no public SDK route lets a plugin raise a user notification.
      bb.log.info(`${result.added} new item(s); ${result.total} in queue`);
    }
    return result;
  }

  let idleRefresh: Promise<void> | null = null;
  let idleRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let trailingIdleRefresh = false;
  let disposed = false;
  let lastIdleRefreshAt = -Infinity;
  function runIdleRefresh(): Promise<void> {
    lastIdleRefreshAt = Date.now();
    const refresh = (async () => {
      try {
        await pollOnce();
      } catch (cause) {
        bb.log.warn(`idle refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        idleRefresh = null;
      }
    })();
    idleRefresh = refresh;
    return refresh;
  }
  function scheduleTrailingIdleRefresh(): void {
    if (trailingIdleRefresh || disposed) return;
    trailingIdleRefresh = true;
    const remaining = Math.max(0, lastIdleRefreshAt + 60_000 - Date.now());
    idleRefreshTimer = setTimeout(() => {
      idleRefreshTimer = null;
      const active = idleRefresh;
      if (active !== null) {
        void active.then(() => {
          if (disposed || !trailingIdleRefresh) return;
          trailingIdleRefresh = false;
          void runIdleRefresh();
        });
      } else if (!disposed && trailingIdleRefresh) {
        trailingIdleRefresh = false;
        void runIdleRefresh();
      }
    }, remaining);
  }
  bb.events.on("thread.idle", async ({ thread }) => {
    try {
      const items = await readQueue();
      if (!items.some((item) => item.state === "started" && item.threadId === thread.id)) return;
      if (idleRefresh !== null) {
        scheduleTrailingIdleRefresh();
        return;
      }
      if (trailingIdleRefresh) return;
      const remaining = lastIdleRefreshAt + 60_000 - Date.now();
      if (remaining <= 0) {
        await runIdleRefresh();
      } else {
        scheduleTrailingIdleRefresh();
      }
    } catch (cause) {
      bb.log.warn(`idle refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });

  bb.background.service("poll", {
    async start(signal) {
      while (!signal.aborted) {
        await pollOnce();
        if (signal.aborted) return;
        await sleepUntilAborted(
          Math.max(1, current.pollMinutes) * 60_000,
          signal,
        );
      }
    },
  });

  // -------------------------------------------------------------------------
  // Start — the only action with side effects.
  // -------------------------------------------------------------------------

  async function reviewEnvironment(
    projectId: string,
  ): Promise<Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["environment"]> {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find((source) => source.isDefault) ??
      (project.sources.length === 1 ? project.sources[0] : undefined);
    if (source === undefined) {
      throw new Error("Choose a default project checkout in BB before starting a review.");
    }
    return {
      type: "host",
      hostId: source.hostId,
      workspace: { type: "unmanaged", path: source.path },
    };
  }

  async function startItem(key: string): Promise<Lookup> {
    return withQueueLock(async () => {
      const items = await readQueue();
      const found = lookup(items, key);
      if (!found.ok) return found;
      const item = found.item;
      if (item.threadId !== undefined) return { ok: true, item };
      if (item.state !== "queued") {
        return { ok: false, message: `${item.repo}#${item.number} is already ${item.state}.` };
      }

      const projectId = current.project;
      if (projectId === undefined) {
        return { ok: false, message: `No project is configured. ${CONFIGURE_HINT}` };
      }

      const thread = await bb.sdk.threads.spawn({
        projectId,
        prompt: promptFor(item),
        title: `Review ${item.repo}#${item.number} (${prSummary(item)})`,
        environment: await reviewEnvironment(projectId),
        pluginMetadata: { itemKey: item.key, repo: item.repo, number: item.number },
        ...(current.provider === undefined ? {} : { providerId: current.provider }),
        ...(current.model === undefined ? {} : { model: current.model }),
      });

      const started: QueueItem = { ...item, state: "started", threadId: thread.id };
      await writeQueue(items.map((row) => (row.key === item.key ? started : row)));
      bb.log.info(`${item.repo}#${item.number} → thread ${thread.id}`);
      return { ok: true, item: started };
    });
  }

  async function startBatch(keys: string[]): Promise<{ threadId: string; items: QueueItem[] }> {
    return withQueueLock(async () => {
      if (keys.length === 0 || new Set(keys).size !== keys.length) {
        throw new Error("Select at least one distinct queue item.");
      }
      const queue = await readQueue();
      const selected = keys.map((key) => {
        const matches = queue.filter((item) => item.key === key);
        if (matches.length !== 1) throw new Error(`No unique exact queue item matches ${key}.`);
        return matches[0]!;
      });
      if (new Set(selected.map((item) => item.key)).size !== selected.length) {
        throw new Error("Select distinct queue items.");
      }
      for (const item of selected) {
        if (item.state !== "queued" || item.threadId !== undefined) {
          throw new Error(`${item.repo}#${item.number} is already ${item.state}.`);
        }
      }
      const projectId = current.project;
      if (projectId === undefined) throw new Error(`No project is configured. ${CONFIGURE_HINT}`);
      const thread = await bb.sdk.threads.spawn({
        projectId,
        prompt: batchPrompt(selected),
        title: `Review ${selected.length} pull requests`,
        environment: await reviewEnvironment(projectId),
        pluginMetadata: { itemKeys: selected.map((item) => item.key) },
        ...(current.provider === undefined ? {} : { providerId: current.provider }),
        ...(current.model === undefined ? {} : { model: current.model }),
      });
      const started = selected.map((item): QueueItem => ({ ...item, state: "started", threadId: thread.id }));
      const byKey = new Map(started.map((item) => [item.key, item]));
      await writeQueue(queue.map((item) => byKey.get(item.key) ?? item));
      bb.log.info(`Started ${started.length} reviews → thread ${thread.id}`);
      return { threadId: thread.id, items: started };
    });
  }

  async function dismissItem(key: string): Promise<Lookup> {
    return withQueueLock(async () => {
      const items = await readQueue();
      const found = lookup(items, key);
      if (!found.ok) return found;
      const dismissed: QueueItem = { ...found.item, state: "dismissed" };
      await writeQueue(
        items.map((row) => (row.key === dismissed.key ? dismissed : row)),
      );
      return { ok: true, item: dismissed };
    });
  }

  // -------------------------------------------------------------------------
  // RPC for the Reviews page.
  // -------------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    queue_list: async () => ({
      items: await visibleQueue(),
      lastPoll: await readLastPoll(),
    }),
    item_start: async ({ key }) => {
      const result = await startItem(key);
      if (!result.ok) throw new Error(result.message);
      return { item: result.item };
    },
    item_batch_start: async ({ keys }) => startBatch(keys),
    item_dismiss: async ({ key }) => {
      const result = await dismissItem(key);
      if (!result.ok) throw new Error(result.message);
      return { item: result.item };
    },
    poll_now: async () => {
      const { ok, added, removed, total, changed, error } = await pollOnce();
      return {
        ok,
        added,
        removed,
        total,
        changed,
        ...(error === undefined ? {} : { error }),
      };
    },
  });

  // -------------------------------------------------------------------------
  // CLI.
  // -------------------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb review-watch list [--rule <rule>] [--json]",
    "  bb review-watch start <key> [--json]",
    "  bb review-watch dismiss <key> [--json]",
    "  bb review-watch poll [--json]",
    "  bb review-watch status [--json]",
    "",
    `Rules: ${ruleSchema.options.join(", ")}. A key may be any unambiguous prefix.`,
  ].join("\n");

  function ok(stdout: string): { exitCode: number; stdout: string } {
    return { exitCode: 0, stdout: `${clampOutput(stdout)}\n` };
  }

  function fail(stderr: string): { exitCode: number; stderr: string } {
    return { exitCode: 1, stderr: `${clampOutput(stderr)}\n` };
  }

  function formatRow(item: QueueItem, now: number): string {
    const cells = [
      item.key.slice(0, 24),
      `${item.repo}#${item.number}`,
      relativeAge(item.updatedAt, now),
      item.state,
      item.title.slice(0, 48),
      item.reason,
    ];
    return cells.join("  ");
  }

  bb.cli.register({
    name: "review-watch",
    summary: "Read the GitHub review queue and start work on one item.",
    commands: [
      {
        name: "list",
        summary: "Show the queue.",
        usage: "bb review-watch list [--rule <rule>] [--json]",
      },
      {
        name: "start",
        summary: "Spawn a thread for one item.",
        usage: "bb review-watch start <key> [--json]",
      },
      {
        name: "dismiss",
        summary: "Drop one item from the queue.",
        usage: "bb review-watch dismiss <key> [--json]",
      },
      {
        name: "poll",
        summary: "Run one poll now.",
        usage: "bb review-watch poll [--json]",
      },
      {
        name: "status",
        summary: "Show configuration and queue counts.",
        usage: "bb review-watch status [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const rest = argv.filter((arg) => arg !== "--json");
      const [command, ...args] = rest;

      switch (command) {
        case undefined:
        case "help":
        case "--help":
        case "-h":
          return { exitCode: 0, stdout: `${usage}\n` };

        case "list": {
          let items = await visibleQueue();
          const ruleIndex = args.indexOf("--rule");
          if (ruleIndex !== -1) {
            const wanted = ruleSchema.safeParse(args[ruleIndex + 1]);
            if (!wanted.success) {
              return fail(`--rule must be one of ${ruleSchema.options.join(", ")}`);
            }
            items = items.filter((item) => item.rule === wanted.data);
          }
          if (json) return ok(JSON.stringify(items));
          if (items.length === 0) return ok("Queue is empty.");
          const now = Date.now();
          const sections = ruleSchema.options.flatMap((rule) => {
            const group = items.filter((item) => item.rule === rule);
            if (group.length === 0) return [];
            return [
              `${RULE_LABELS[rule]} (${group.length})`,
              ...group.map((item) => `  ${formatRow(item, now)}`),
            ];
          });
          return ok(sections.join("\n"));
        }

        case "start":
        case "dismiss": {
          const key = args[0];
          if (key === undefined || args.length !== 1) {
            return fail(`usage: bb review-watch ${command} <key>`);
          }
          const result =
            command === "start" ? await startItem(key) : await dismissItem(key);
          if (!result.ok) return fail(result.message);
          const { item } = result;
          if (json) return ok(JSON.stringify(item));
          return ok(
            command === "start"
              ? `Started ${item.repo}#${item.number} in thread ${item.threadId ?? "(unknown)"}`
              : `Dismissed ${item.repo}#${item.number}`,
          );
        }

        case "poll": {
          const result = await pollOnce();
          if (json) return ok(JSON.stringify(result));
          if (!result.ok) return fail(`Poll failed: ${result.error ?? "unknown error"}`);
          return ok(
            result.changed
              ? `Polled: ${result.added} added, ${result.removed} removed, ${result.total} in queue.`
              : `Polled: no change, ${result.total} in queue.`,
          );
        }

        case "status": {
          const items = await readQueue();
          const lastPoll = await readLastPoll();
          const queuedCounts = Object.fromEntries(
            ruleSchema.options.map((rule) => [
              rule,
              items.filter((item) => item.rule === rule && item.state === "queued").length,
            ]),
          ) as Record<Rule, number>;
          const pendingCounts = Object.fromEntries(
            ruleSchema.options.map((rule) => [
              rule,
              items.filter((item) => item.rule === rule && (item.state === "queued" || item.state === "started"))
                .length,
            ]),
          ) as Record<Rule, number>;
          const transport = transportKind();
          const state = {
            // Which route a poll takes, and for `gh` the binary a poll resolved
            // — the first thing to check when the queue is unexpectedly empty.
            transport,
            ghPath: transport === "gh" ? (ghBinaryPath() ?? null) : null,
            githubToken: configuredToken() !== undefined,
            project: current.project ?? null,
            viewerLogin: cachedLogin,
            pollMinutes: current.pollMinutes,
            repoAllowlist: allowlist,
            maxAgeDays: current.maxAgeDays,
            lastPoll,
            queued: queuedCounts,
            pending: pendingCounts,
            started: items.filter((item) => item.state === "started").length,
            archived: items.filter((item) => item.state === "archived").length,
          };
          if (json) return ok(JSON.stringify(state));
          return ok(
            [
              `transport:    ${
                state.transport === "token"
                  ? "token (githubToken)"
                  : `gh (${state.ghPath ?? "binary not resolved yet"})`
              }`,
              `githubToken:  ${state.githubToken ? "set" : "empty"}`,
              `project:      ${state.project ?? "missing"}`,
              `viewerLogin:  ${state.viewerLogin ?? "(not resolved yet)"}`,
              `poll:         every ${state.pollMinutes}m, drop after ${state.maxAgeDays}d`,
              `allowlist:    ${allowlist.length === 0 ? "(every repository)" : allowlist.join(", ")}`,
              `last poll:    ${
                lastPoll === null
                  ? "never"
                  : `${lastPoll.at} — ${lastPoll.ok ? `ok, ${lastPoll.added} added` : `failed: ${lastPoll.error ?? "unknown error"}`}`
              }`,
              "pending by rule:",
              ...ruleSchema.options.map(
                (rule) => `${`${RULE_LABELS[rule]}:`.padEnd(14)}${pendingCounts[rule]}`,
              ),
              `started:      ${state.started}`,
              `archived:     ${state.archived}`,
            ].join("\n"),
          );
        }
      }
      return fail(usage);
    },
  });

  bb.onDispose(() => {
    disposed = true;
    trailingIdleRefresh = false;
    if (idleRefreshTimer !== null) clearTimeout(idleRefreshTimer);
    cachedLogin = null;
    // Drops the cached `gh` probe, and the token the transport closed over.
    ghTransport = null;
    tokenTransport = null;
  });
}
