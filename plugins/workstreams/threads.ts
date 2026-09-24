// Linking BB threads to ticket clusters. Pure: no SDK, no I/O except what the
// caller injects. Every link is DETERMINISTIC and says which rule made it, so a
// wrong link can be traced to the rule that produced it.
//
// Four tiers, strongest first. A thread may link to several clusters, and to
// each one through its strongest tier only.
//   0. started     — the thread was started from the Board for this cluster:
//      the plugin seeded its own thread metadata with the cluster's ticket at
//      spawn time. The one link that is a record rather than an inference, so
//      it beats every inferred tier below.
//   1. environment — the thread runs in the checkout itself: its environment
//      path IS a unit's path, or its environment branch IS a unit's branch.
//   2. ticket      — the thread's title names the ticket.
//   3. paths       — the thread worked inside a unit's checkout: a recent cwd,
//      command, file change or tool argument names a path within it.
// No fuzzy matching and no model: a link nobody can explain is worse than a
// missing one, because the reader stops trusting every mark on the map.

export const THREAD_TIERS = ["started", "environment", "ticket", "paths"] as const;
export type ThreadTier = (typeof THREAD_TIERS)[number];

const TIER_RANK = new Map<ThreadTier, number>(THREAD_TIERS.map((tier, index) => [tier, index]));

/** What linking reads about one thread. `workedPaths` comes from its event log. */
export type ThreadFacts = {
  id: string;
  title: string | null;
  titleFallback: string | null;
  status: string;
  environmentBranchName: string | null;
  environmentPath: string | null;
  updatedAt: number;
  workedPaths: readonly string[];
  /** The cluster this plugin's own metadata says the thread was started for. */
  startedFor: string | null;
};

/**
 * Read the cluster out of this plugin's thread metadata namespace. Any client,
 * or the thread's own agent, can write that namespace, so the value is
 * validated here and only ever used to draw a link — never to grant anything.
 */
export function startedForOf(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const ticket = (metadata as Record<string, unknown>).ticket;
  return typeof ticket === "string" && ticket.trim() !== "" && ticket.length <= 300 ? ticket : null;
}

/** One checkout a thread can land in, and the cluster it belongs to. */
export type LinkTarget = {
  cluster: string;
  path: string;
  branch: string | null;
  defaultBranch: string | null;
};

/**
 * Branches every checkout of a repo shares. A thread on `main` has said nothing
 * about which ticket it is working on, so a branch match there is not evidence.
 */
const SHARED_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

/** Every ticket key the pattern finds in `text`, uppercased, in order. */
export function ticketsIn(text: string, pattern: RegExp): string[] {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const out: string[] = [];
  for (const match of text.matchAll(global)) {
    if (match[1] === undefined || match[2] === undefined) continue;
    const key = `${match[1].toUpperCase()}-${match[2]}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** True when `worked` is the checkout itself or a path inside it. */
export function withinPath(worked: string, checkout: string): boolean {
  const root = checkout.replace(/\/+$/u, "");
  return worked === root || worked.startsWith(`${root}/`);
}

/**
 * Link one thread to clusters. Returns cluster → strongest tier. Tier 2 only
 * counts a ticket that is actually a cluster on the board: a title that names
 * some other team's ticket is not a link to anything here.
 */
export function linkThread(
  thread: ThreadFacts,
  targets: readonly LinkTarget[],
  pattern: RegExp,
): Map<string, ThreadTier> {
  const links = new Map<string, ThreadTier>();
  const offer = (cluster: string, tier: ThreadTier) => {
    const current = links.get(cluster);
    if (current === undefined || (TIER_RANK.get(tier) ?? 9) < (TIER_RANK.get(current) ?? 9)) {
      links.set(cluster, tier);
    }
  };
  const clusters = new Set(targets.map((target) => target.cluster));
  // A branch name is only evidence when it identifies one cluster on this
  // board. Different repositories often reuse names such as feature/auth.
  const branchClusters = new Map<string, Set<string>>();
  for (const target of targets) {
    if (target.branch === null || target.branch === target.defaultBranch || SHARED_BRANCHES.has(target.branch)) continue;
    const owners = branchClusters.get(target.branch) ?? new Set<string>();
    owners.add(target.cluster);
    branchClusters.set(target.branch, owners);
  }
  const knownEnvironmentPath = typeof thread.environmentPath === "string" && targets.some(
    (target) => thread.environmentPath?.replace(/\/+$/u, "") === target.path.replace(/\/+$/u, ""),
  );

  if (thread.startedFor !== null && clusters.has(thread.startedFor)) offer(thread.startedFor, "started");

  for (const target of targets) {
    const samePath =
      typeof thread.environmentPath === "string" && thread.environmentPath.replace(/\/+$/u, "") === target.path.replace(/\/+$/u, "");
    const sameBranch =
      thread.environmentBranchName !== null &&
      target.branch !== null &&
      thread.environmentBranchName === target.branch &&
      target.branch !== target.defaultBranch &&
      !SHARED_BRANCHES.has(target.branch) &&
      branchClusters.get(target.branch)?.size === 1 &&
      (!knownEnvironmentPath || samePath);
    if (samePath || sameBranch) offer(target.cluster, "environment");
  }

  const text = [thread.title ?? "", thread.titleFallback ?? ""].join("\n");
  for (const ticket of ticketsIn(text, pattern)) {
    if (clusters.has(ticket)) offer(ticket, "ticket");
  }

  for (const worked of thread.workedPaths) {
    for (const target of targets) {
      if (withinPath(worked, target.path)) offer(target.cluster, "paths");
    }
  }
  return links;
}

// ---- reading the event log -------------------------------------------------

/** The bounds on one thread's event-log read. */
export const EVENT_READ = {
  /** Events per page, and the most pages: at most `page * pages` entries. */
  page: 25,
  pages: 4,
  /** Stop paging once the serialized rows read so far pass this many bytes. */
  bytes: 1_000_000,
  /** Distinct paths kept per thread. */
  paths: 400,
  /** One page may take this long before the thread is skipped. */
  timeoutMs: 8_000,
  /** Threads read at once. */
  concurrency: 4,
} as const;

/** An absolute path token inside a shell command or argument. */
const PATH_TOKEN = /(?:^|[\s'"`=:(,])(\/[^\s'"`;|&<>(){},]+)/gu;

function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (const match of text.slice(0, 4_000).matchAll(PATH_TOKEN)) {
    const token = match[1]?.replace(/[.:]+$/u, "");
    if (token !== undefined && token.length > 1) out.push(token.replace(/\/+$/u, "") || "/");
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * The absolute paths a page of `item/started` events worked in: a command's
 * cwd and the paths its command line names, the paths a file change touched, a
 * file read, and the string arguments of a tool call. Parsed defensively —
 * these rows are provider output and a malformed one is skipped, not fatal.
 */
export function pathsFromEvents(rows: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const item = asRecord(asRecord(asRecord(row)?.data)?.item);
    if (item === null) continue;
    switch (item.type) {
      case "commandExecution":
        if (typeof item.cwd === "string" && item.cwd.startsWith("/")) out.push(item.cwd.replace(/\/+$/u, ""));
        if (typeof item.command === "string") out.push(...pathTokens(item.command));
        break;
      case "fileChange":
        if (Array.isArray(item.changes)) {
          for (const change of item.changes) {
            const path = asRecord(change)?.path;
            if (typeof path === "string" && path.startsWith("/")) out.push(path);
          }
        }
        break;
      case "fileRead":
      case "listFiles":
        if (typeof item.path === "string" && item.path.startsWith("/")) out.push(item.path);
        break;
      case "toolCall": {
        const args = asRecord(item.arguments);
        for (const value of Object.values(args ?? {})) {
          if (typeof value === "string") out.push(...pathTokens(` ${value}`));
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** What the cache keeps per thread: the paths, and the `updatedAt` they were read at. */
export type WorkedPaths = { updatedAt: number; paths: string[] };

/**
 * Bring every thread's worked paths up to date. A thread whose `updatedAt` is
 * the one its cached paths were read at is NEVER re-read: an unchanged thread
 * cannot have worked anywhere new. Reads run at most `concurrency` at once, and
 * a read that fails or times out skips that thread — it keeps its old paths, if
 * any, and is retried on its next change — rather than failing the pass.
 */
export async function refreshWorkedPaths(options: {
  threads: readonly { id: string; updatedAt: number }[];
  cached: (id: string) => WorkedPaths | undefined;
  read: (id: string, signal: AbortSignal) => Promise<string[]>;
  concurrency?: number;
  timeoutMs?: number;
}): Promise<{ updates: Map<string, WorkedPaths>; read: number; reused: number; failed: number }> {
  const concurrency = options.concurrency ?? EVENT_READ.concurrency;
  const timeoutMs = options.timeoutMs ?? EVENT_READ.timeoutMs;
  const updates = new Map<string, WorkedPaths>();
  const pending = options.threads.filter((thread) => options.cached(thread.id)?.updatedAt !== thread.updatedAt);
  let read = 0;
  let failed = 0;
  let next = 0;
  const lane = async () => {
    while (next < pending.length) {
      const thread = pending[next++]!;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const paths = await Promise.race([
          options.read(thread.id, controller.signal),
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true }),
          ),
        ]);
        updates.set(thread.id, { updatedAt: thread.updatedAt, paths: [...new Set(paths)].slice(0, EVENT_READ.paths) });
        read += 1;
      } catch {
        failed += 1;
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, lane));
  return { updates, read, reused: options.threads.length - pending.length, failed };
}

// ---- coverage --------------------------------------------------------------

export type ThreadCoverage = {
  threads: number;
  linked: number;
  /** Each linked thread counted once, under its STRONGEST tier. */
  byTier: Record<ThreadTier, number>;
  clustersWithThread: number;
};

/** The honest numbers: how much of the thread list the rules actually reached. */
export function threadCoverage(
  threadCount: number,
  links: ReadonlyMap<string, ReadonlyMap<string, ThreadTier>>,
): ThreadCoverage {
  const byTier: Record<ThreadTier, number> = { started: 0, environment: 0, ticket: 0, paths: 0 };
  const clusters = new Set<string>();
  let linked = 0;
  for (const perCluster of links.values()) {
    if (perCluster.size === 0) continue;
    linked += 1;
    let best: ThreadTier = "paths";
    for (const [cluster, tier] of perCluster) {
      clusters.add(cluster);
      if ((TIER_RANK.get(tier) ?? 9) < (TIER_RANK.get(best) ?? 9)) best = tier;
    }
    byTier[best] += 1;
  }
  return { threads: threadCount, linked, byTier, clustersWithThread: clusters.size };
}

// ---- threads as a grouping signal -------------------------------------------

/** The tiers that say a thread WORKED on a cluster. `paths` only says it passed through. */
export const STRONG_TIERS: ReadonlySet<ThreadTier> = new Set(["started", "environment", "ticket"]);
/** A thread strongly linking more clusters than this is a planning thread: it says nothing about any pair. */
export const THREAD_SPAN_MAX = 8;

/**
 * Cluster → thread → specificity weight, for seeding. A thread strongly linking
 * n clusters gives each pair among them 1/(n−1): two tickets worked on in one
 * focused thread belong together in the user's head, while a thread that
 * touched eight tickets is weak evidence about any two of them. `paths` links
 * never count — one broad planning thread would glue the whole board together —
 * and a thread linking one cluster, or more than THREAD_SPAN_MAX, gives nothing.
 */
export function threadWeights(
  links: ReadonlyMap<string, ReadonlyMap<string, ThreadTier>>,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [thread, perCluster] of links) {
    const strong = [...perCluster].filter(([, tier]) => STRONG_TIERS.has(tier)).map(([cluster]) => cluster);
    if (strong.length < 2 || strong.length > THREAD_SPAN_MAX) continue;
    const weight = 1 / (strong.length - 1);
    for (const cluster of strong) {
      const bucket = out.get(cluster) ?? new Map<string, number>();
      bucket.set(thread, weight);
      out.set(cluster, bucket);
    }
  }
  return out;
}

/** How many clusters have at least one strong thread link: reported, so the signal's reach is visible. */
export function strongLinkedClusters(links: ReadonlyMap<string, ReadonlyMap<string, ThreadTier>>): number {
  const clusters = new Set<string>();
  for (const perCluster of links.values()) {
    for (const [cluster, tier] of perCluster) if (STRONG_TIERS.has(tier)) clusters.add(cluster);
  }
  return clusters.size;
}
