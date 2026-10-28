/**
 * Whether a plugin asked thread-briefs to leave a thread alone entirely.
 *
 * Pure: the lookups live in `server.ts`. The exemption is asked for by the
 * plugin that spawned the thread, not by this one: a plugin that runs a
 * long-lived thread knows things a brief cannot — that its title is a key
 * people search for, that "done for now" is its resting state, that it is
 * the one thread you always want where you left it. So it seeds
 *
 * ```ts
 * pluginMetadata: { threadBriefs: false }
 * ```
 *
 * in its own metadata namespace when it spawns the thread, and this plugin
 * reads it back from the namespace of the plugin that owns the thread. For a
 * thread a plugin spawned that is `thread.originPluginId`. A worker or
 * reviewer a long-lived thread spawns through the CLI has no origin plugin of
 * its own, so the owning plugin is the nearest ancestor's along the
 * `lifecycleOwnerThreadId` chain, and the tag still lives in that plugin's
 * namespace. This plugin never has to know which plugins exist.
 *
 * Off is one switch for the whole thread: no summary, no stored brief, no
 * rename, no section, no ring, no auto-archive, no re-entry refresher and no
 * Stage/Status actions — the brief's absence is what makes every one of those
 * skip it.
 *
 * The legacy per-key object is read too, and off when any one of its keys is
 * `false`, so a thread tagged before the switch needs no re-tag. That reading
 * can go a release later.
 */

/** The key a spawning plugin sets in its own metadata namespace. */
export const OPT_OUT_KEY = "threadBriefs";

/**
 * Whether the owning plugin's metadata namespace turns thread-briefs off.
 *
 * `threadBriefs: false` is off. A legacy `{ rename, group, archive, ring }`
 * object is off when at least one key is `false`. Anything else — no value at
 * all, `true`, or an object with every key true — leaves the thread on.
 */
export function readOptOut(metadata: unknown): boolean {
  if (typeof metadata !== "object" || metadata === null) return false;
  const value = (metadata as Record<string, unknown>)[OPT_OUT_KEY];
  if (value === false) return true;
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.rename === false ||
    entry.group === false ||
    entry.archive === false ||
    entry.ring === false
  );
}
