// The usage view: every watch on this server with how busy it has been,
// what stands out about it, what stewards asked to have leased beside the
// watches, and what the doorbell stream is doing. Pure: the server hands it
// rows, the hooks status, thread titles and stewards' interest; the settings
// section and `bb github-watcher watches` render the result. The linear
// plugin carries the same module; a change here belongs there too.
import { z } from "zod";
import { ago, until } from "./format-time.js";
import { STATUS_WINDOW_MS, type HooksStatus } from "./hooks-client.js";
import { expiresAt, flagsFor, NEAR_LIMIT_AT, WATCH_LIMIT, WATCH_TTL_MS, wakesInWindow, type WatchFlag, type WatchRow } from "./watch.js";

const flagSchema = z.enum(["idle", "noisy", "expiring"]);

export const hooksViewSchema = z.object({
  /** Whether this server has a bb-gate-hooks service at all (BB_HOOKS_URL). */
  configured: z.boolean(),
  state: z.enum(["stopped", "connecting", "connected"]),
  since: z.number(),
  leased: z.boolean(),
  leasedUntil: z.number(),
  windowMs: z.number(),
  doorbells: z.number(),
  lastDoorbellAt: z.number(),
  sweeps: z.number(),
  lastSweepAt: z.number(),
  lastSweepReason: z.string().nullable(),
});

export const watchViewSchema = z.object({
  threadId: z.string(),
  threadTitle: z.string().nullable(),
  projectId: z.string(),
  target: z.object({
    /** What the store and the lease name it by. */
    id: z.string(),
    /** What a person calls it. */
    key: z.string(),
    kind: z.string(),
    title: z.string().nullable(),
    url: z.string().nullable(),
  }),
  /** The state the watch last saw, so a reader knows what the next wake is diffed against. */
  state: z.string().nullable(),
  createdAt: z.number(),
  lastActivityAt: z.number(),
  expiresAt: z.number(),
  lastCheckedAt: z.number(),
  lastWokeAt: z.number(),
  checks: z.number(),
  wakes: z.number(),
  wakesInWindow: z.number(),
  flags: z.array(flagSchema),
});

export const threadViewSchema = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  count: z.number(),
  wakes: z.number(),
  nearLimit: z.boolean(),
});

const nounSchema = z.tuple([z.string(), z.string()]);

/**
 * What stewards asked this server to lease beside the watches: the teams or
 * repositories it hears of new entities in, and the entities it has bound.
 * Leased on the same stream, so a reader looking at "why did nothing wake"
 * needs it as much as the watches.
 */
export const interestViewSchema = z.object({
  /** What units and entities are called here, singular then plural. */
  nouns: z.object({ unit: nounSchema, entity: nounSchema }),
  /** As a person names them. */
  units: z.array(z.string()),
  /** Repositories whose Dependabot alerts are leased, separate from `units`. */
  dependabot: z.array(z.string()).default([]),
  entities: z.array(z.object({ key: z.string(), url: z.string().nullable() })),
  /** What stewards asked for and is not leased, and why. Empty when all is well. */
  unleased: z.array(z.object({ key: z.string(), reason: z.string() })),
});

export const usageViewSchema = z.object({
  now: z.number(),
  limit: z.number(),
  ttlMs: z.number(),
  hooks: hooksViewSchema,
  interest: interestViewSchema,
  threads: z.array(threadViewSchema),
  /** Problems first, then the busiest. */
  watches: z.array(watchViewSchema),
});

export type HooksView = z.infer<typeof hooksViewSchema>;
export type WatchView = z.infer<typeof watchViewSchema>;
export type ThreadView = z.infer<typeof threadViewSchema>;
export type InterestView = z.infer<typeof interestViewSchema>;
export type UsageView = z.infer<typeof usageViewSchema>;

/** What the plugin knows about a watch's target that the row does not spell out. */
export type TargetOf = (watch: WatchRow) => WatchView["target"];

const FLAG_RANK: Record<WatchFlag, number> = { noisy: 0, idle: 1, expiring: 2 };
const rank = (flags: WatchFlag[]) => Math.min(3, ...flags.map((f) => FLAG_RANK[f]));

/** Flagged watches first (noisy, then idle, then expiring), then by wakes, checks and age. */
export function orderWatches(watches: WatchView[]): WatchView[] {
  return [...watches].sort((a, b) => rank(a.flags) - rank(b.flags) || b.wakesInWindow - a.wakesInWindow || b.wakes - a.wakes || b.checks - a.checks || a.createdAt - b.createdAt);
}

/**
 * Leases bb-gate-hooks refused for stewards. The service says so only in
 * the answer to a lease, and every renewal asks again, so a refusal is
 * current until a renewal has had time to repeat it.
 */
export function createRefusals(now: () => number, keepMs = STATUS_WINDOW_MS) {
  const refused = new Map<string, { reason: string; at: number }>();
  return {
    add(id: string, reason: string): void {
      refused.set(id, { reason, at: now() });
    },
    /** The refusals still current, by lease id. */
    current(): Map<string, string> {
      const cutoff = now() - keepMs;
      for (const [id, r] of refused) if (r.at <= cutoff) refused.delete(id);
      return new Map([...refused].map(([id, r]) => [id, r.reason]));
    },
  };
}

export function buildUsage(input: { rows: WatchRow[]; hooks: HooksStatus; configured: boolean; now: number; titles: Map<string, string | null>; target: TargetOf; interest: InterestView }): UsageView {
  const { rows, now } = input;
  const watches = orderWatches(
    rows.map((row) => ({
      threadId: row.threadId,
      threadTitle: input.titles.get(row.threadId) ?? null,
      projectId: row.projectId,
      target: input.target(row),
      state: row.snapshot.state,
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
      expiresAt: expiresAt(row),
      lastCheckedAt: row.lastCheckedAt,
      lastWokeAt: row.lastWokeAt,
      checks: row.checks,
      wakes: row.wakes,
      wakesInWindow: wakesInWindow(row, now),
      flags: flagsFor(row, now),
    })),
  );
  const byThread = new Map<string, ThreadView>();
  for (const w of watches) {
    const t = byThread.get(w.threadId) ?? { threadId: w.threadId, title: w.threadTitle, count: 0, wakes: 0, nearLimit: false };
    t.count += 1;
    t.wakes += w.wakes;
    t.nearLimit = t.count >= NEAR_LIMIT_AT;
    byThread.set(w.threadId, t);
  }
  const threads = [...byThread.values()].sort((a, b) => b.count - a.count || b.wakes - a.wakes || a.threadId.localeCompare(b.threadId));
  return { now, limit: WATCH_LIMIT, ttlMs: WATCH_TTL_MS, hooks: { configured: input.configured, ...input.hooks }, interest: input.interest, threads, watches };
}

// ---- text, for the CLI ---------------------------------------------------------

export function describeHooks(h: HooksView, now: number): string {
  if (!h.configured) return "Doorbells: unavailable (BB_HOOKS_URL is not set); watches cannot be added.";
  const state = h.state === "connected" ? (h.leased ? "connected and leased" : "connected, leases pending") : h.state === "connecting" ? "reconnecting (checks fall back to a slow sweep)" : "stopped";
  const activity = `${h.doorbells} doorbell${h.doorbells === 1 ? "" : "s"} and ${h.sweeps} sweep${h.sweeps === 1 ? "" : "s"} in the last ${Math.round(h.windowMs / 60_000)} min`;
  return `Doorbells: ${state} for ${ago(h.since, now)}; ${activity}; last sweep ${ago(h.lastSweepAt, now)}${h.lastSweepReason === null ? "" : ` (${h.lastSweepReason})`}.`;
}

const count = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

/** At most this many entities are named on the stewards line; --json has them all. */
const ENTITIES_NAMED = 20;

/** What stewards has leased, one line, then a line per thing it asked for that is not leased. */
export function describeInterest(i: InterestView): string[] {
  if (i.units.length === 0 && i.entities.length === 0 && (i.dependabot ?? []).length === 0 && i.unleased.length === 0) return ["Stewards: nothing asked for."];
  const parts: string[] = [];
  if (i.units.length > 0) parts.push(`${i.units.length === 1 ? i.nouns.unit[0] : i.nouns.unit[1]} ${i.units.join(", ")}`);
  if ((i.dependabot ?? []).length > 0) parts.push(`Dependabot alerts for ${(i.dependabot ?? []).join(", ")}`);
  if (i.entities.length > 0) {
    const named = i.entities.slice(0, ENTITIES_NAMED).map((e) => e.key);
    const more = i.entities.length - named.length;
    parts.push(`${count(i.entities.length, i.nouns.entity)} (${named.join(", ")}${more > 0 ? `, and ${more} more` : ""})`);
  }
  const lines = [`Stewards: ${parts.length > 0 ? parts.join("; ") : "nothing leased"}.`];
  for (const u of i.unleased) lines.push(`Not leased for stewards: ${u.key}: ${u.reason}.`);
  return lines;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** The whole view as fixed-width text. */
export function formatUsage(view: UsageView): string {
  const lines: string[] = [describeHooks(view.hooks, view.now), ...describeInterest(view.interest)];
  if (view.watches.length === 0) {
    lines.push("No thread watches anything.");
    return lines.join("\n");
  }
  lines.push(`${view.watches.length} watch${view.watches.length === 1 ? "" : "es"} across ${view.threads.length} thread${view.threads.length === 1 ? "" : "s"} (limit ${view.limit} per thread; a watch idle for ${Math.round(view.ttlMs / 86_400_000)} days is forgotten).`);
  const near = view.threads.filter((t) => t.nearLimit);
  for (const t of near) lines.push(`Near limit: thread ${t.title ?? t.threadId} watches ${t.count} of ${view.limit}.`);
  lines.push("");
  const rows = view.watches.map((w) => [
    w.target.key,
    w.threadTitle ?? w.threadId,
    ago(w.createdAt, view.now),
    `${w.checks}`,
    `${w.wakes}${w.wakesInWindow > 0 ? ` (${w.wakesInWindow}/h)` : ""}`,
    ago(w.lastWokeAt, view.now),
    until(w.expiresAt, view.now),
    w.flags.join(", "),
  ]);
  const header = ["TARGET", "THREAD", "AGE", "CHECKS", "WAKES", "LAST WOKE", "EXPIRES", "FLAGS"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i]!))).join("  ").trimEnd();
  lines.push(line(header), ...rows.map(line));
  return lines.join("\n");
}
