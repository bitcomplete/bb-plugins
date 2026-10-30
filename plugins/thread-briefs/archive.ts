/**
 * Which finished threads have gone cold enough to archive.
 *
 * Pure: every `bb.*` call lives in `server.ts`. The whole decision is a filter
 * over the thread rows the sweep already lists plus the stored briefs it
 * already reads, so it can be tested without a server — which matters more here
 * than anywhere else in this plugin, because this is the only code that removes
 * something from the user's sidebar without being asked.
 */
import { isStaleDone } from "./shared.js";

/** The thread-row fields the sweep decides on. */
export interface ArchiveCandidate {
  id: string;
  /** bb's attention cursor: see `idleMsSince`. */
  latestAttentionAt: number;
  /** Null when the thread is not pinned. */
  pinnedAt: number | null;
  /** Null when the thread is not archived. */
  archivedAt: number | null;
  deletedAt: number | null;
  visibility: string;
  /** The thread's live execution status. */
  status: string;
  /**
   * The plugin that spawned the thread exempted it from auto-archiving, or
   * its namespace could not be read: see `optout.ts`.
   */
  optedOut: boolean;
}

/** What the brief says about a thread, for the two facts this needs. */
export interface ArchiveBriefFacts {
  /** The brief's effective status, overrides folded in. */
  status: string;
  /** Set when we archived this thread before and it came back. */
  autoArchivedAt: number | null;
}

/**
 * Statuses that mean the thread is doing something right now.
 *
 * A superset of `LIVE_WORKING_STATUSES` — `stopping` is not "working" for the
 * purposes of a row glyph, but archiving a thread mid-teardown is still a thing
 * to stay out of the way of. An unknown status is treated as idle, as
 * everywhere else in this plugin, because a brief saying `done` is the stronger
 * claim and a status we cannot read should not veto it forever.
 */
const BUSY_STATUSES = new Set(["active", "starting", "pending", "stopping"]);

export interface PlanArchivesArgs {
  threads: readonly ArchiveCandidate[];
  /** Brief facts per thread; a thread absent from this map has no brief. */
  briefs: ReadonlyMap<string, ArchiveBriefFacts>;
  now: number;
  /** Idle milliseconds before a done thread is archived; 0 turns this off. */
  archiveAfterMs: number;
}

/**
 * The ids to archive, and nothing else.
 *
 * Every rule here is a reason *not* to archive, which is the right default for
 * a sweep that runs unattended: a thread wrongly left in the sidebar costs a
 * glance, a thread wrongly archived costs a search for something the user
 * believes they left on screen.
 *
 * - **No brief, or not done.** The only threads eligible are ones this plugin
 *   has read and concluded are finished. A manual `done` pin counts: it is the
 *   user saying so, which is a better signal than the derivation, not a worse
 *   one.
 * - **Pinned.** A pin is a deliberate "keep this in front of me" and outranks
 *   anything inferred. It still goes grey — the ring stays honest about the
 *   thread being cold — it just never leaves.
 * - **Busy, hidden, deleted, already archived.** Nothing to do, or not ours.
 * - **Opted out by its plugin.** A plugin running a long-lived thread knows
 *   when it is finished; a brief reading "done for now" between wakes does
 *   not.
 * - **Auto-archived before.** See `autoArchivedAt` on the stored brief: this is
 *   a thread we archived and the user pulled back, and that decision is final
 *   until they work in it again.
 */
export function planArchives(args: PlanArchivesArgs): string[] {
  if (args.archiveAfterMs <= 0) return [];
  const ids: string[] = [];
  for (const thread of args.threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (thread.visibility === "hidden") continue;
    if (thread.pinnedAt !== null) continue;
    if (thread.optedOut) continue;
    if (BUSY_STATUSES.has(thread.status)) continue;
    const brief = args.briefs.get(thread.id);
    if (brief === undefined) continue;
    if (brief.autoArchivedAt !== null) continue;
    if (
      !isStaleDone({
        status: brief.status,
        latestAttentionAt: thread.latestAttentionAt,
        now: args.now,
        afterMs: args.archiveAfterMs,
      })
    ) {
      continue;
    }
    ids.push(thread.id);
  }
  return ids;
}
