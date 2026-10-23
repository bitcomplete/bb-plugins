/**
 * Which of this plugin's hands-on behaviours a thread is exempt from.
 *
 * Pure: the lookups live in `server.ts`. The exemption is asked for by the
 * plugin that spawned the thread, not by this one: a plugin that runs a
 * long-lived thread knows things a brief cannot — that its title is a key
 * people search for, that "done for now" is its resting state, that it is
 * the one thread you always want where you left it. So it seeds
 *
 * ```ts
 * pluginMetadata: { threadBriefs: { rename: false, group: false, archive: false, ring: false } }
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
 * Each key is an opt-out: `false` turns that behaviour off for the thread,
 * and anything else — absent, `true`, a typo — leaves it on. The brief itself
 * is still written: the panel and the board show it. What is covered is the
 * three things that change the thread or the sidebar without being asked,
 * and the row's ring, which for a thread that idles between wakes mostly
 * says "done" about work that is not.
 */

/** The key a spawning plugin sets in its own metadata namespace. */
export const OPT_OUT_KEY = "threadBriefs";

/** True means the thread is exempt from that behaviour. */
export interface OptOut {
  /** Keep the thread's title: never rename it to the brief's. */
  rename: boolean;
  /** Keep the thread out of the status sections. */
  group: boolean;
  /** Never auto-archive the thread. */
  archive: boolean;
  /** Draw no ring on the thread's sidebar row; bb's own indicators show. */
  ring: boolean;
}

export const NO_OPT_OUT: OptOut = { rename: false, group: false, archive: false, ring: false };

/**
 * Used when the origin plugin's namespace could not be read. Every behaviour
 * here is one the user did not ask for, so not knowing is a reason to hold
 * back: a thread left unrenamed or in the sidebar costs nothing, one archived
 * against its plugin's wishes is the case this exists to prevent.
 */
export const FULL_OPT_OUT: OptOut = { rename: true, group: true, archive: true, ring: true };

/** The opt-out a plugin's metadata namespace asks for. */
export function readOptOut(metadata: unknown): OptOut {
  if (typeof metadata !== "object" || metadata === null) return NO_OPT_OUT;
  const value = (metadata as Record<string, unknown>)[OPT_OUT_KEY];
  if (typeof value !== "object" || value === null) return NO_OPT_OUT;
  const entry = value as Record<string, unknown>;
  return {
    rename: entry.rename === false,
    group: entry.group === false,
    archive: entry.archive === false,
    ring: entry.ring === false,
  };
}

/** Whether an opt-out turns anything off at all. */
export function optsOutOfAnything(optOut: OptOut): boolean {
  return optOut.rename || optOut.group || optOut.archive || optOut.ring;
}
