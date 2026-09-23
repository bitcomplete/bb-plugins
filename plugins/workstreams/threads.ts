// Linking BB threads to ticket clusters. Pure: no SDK, no I/O except what the
// caller injects. Every link is DETERMINISTIC and says which rule made it, so a
// wrong link can be traced to the rule that produced it.
//
// Three tiers, strongest first. A thread may link to several clusters, and to
// each one through its strongest tier only.
//   1. environment — the thread runs in the checkout itself: its environment
//      path IS a unit's path, or its environment branch IS a unit's branch.
//   2. ticket      — the thread's title names the ticket.
//   3. paths       — the thread worked inside a unit's checkout: a recent cwd,
//      command, file change or tool argument names a path within it.
// No fuzzy matching and no model: a link nobody can explain is worse than a
// missing one, because the reader stops trusting every mark on the map.

export const THREAD_TIERS = ["environment", "ticket", "paths"] as const;
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
};

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

  for (const target of targets) {
    const samePath =
      thread.environmentPath !== null && thread.environmentPath.replace(/\/+$/u, "") === target.path.replace(/\/+$/u, "");
    const sameBranch =
      thread.environmentBranchName !== null &&
      target.branch !== null &&
      thread.environmentBranchName === target.branch &&
      target.branch !== target.defaultBranch &&
      !SHARED_BRANCHES.has(target.branch);
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
  const byTier: Record<ThreadTier, number> = { environment: 0, ticket: 0, paths: 0 };
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
