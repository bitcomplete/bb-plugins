/**
 * Runtime values the frontend bundle may import.
 *
 * `contract.ts` reaches `@get-bb/plugin-sdk` root for `defineRpcContract`,
 * which the app build does not resolve, so `app.tsx` imports types from there
 * and every runtime constant from here.
 */

/** Realtime channel: the workspace manifest or repo set for a project changed. */
export const REPOS_CHANGED_CHANNEL = "multi-repo.changed";

/**
 * Realtime channel: one thread's working tree may have moved.
 *
 * Separate from `REPOS_CHANGED_CHANNEL` because that one is answered by the
 * Repos panel with a project-source read, and a signal that fires every time
 * any thread finishes a turn must not drag a git fetch behind it. The payload
 * carries `{ threadId }` so a panel can ignore other threads' turns; realtime
 * has no per-channel subscriptions, so every client sees every signal.
 */
export const THREAD_CHANGES_CHANNEL = "multi-repo.thread-changed";

/**
 * How often the Changes panel re-reads its own thread's diff while open.
 *
 * Polling at all is the concession: nothing in bb tells a panel that a file on
 * a machine changed, and the panel used to load once at mount and then sit on
 * that snapshot for the rest of the thread. A refresh is three short git
 * commands per repo against a warm checkout — cheap enough at this interval,
 * and pull requests are deliberately excluded because they shell out to `gh`.
 */
export const CHANGES_POLL_MS = 5_000;

/** The nav panel's route segment and id. */
export const REPOS_PANEL_ID = "repos";
export const REPOS_PANEL_PATH = "repos";

/**
 * How often the composer banner re-reads its own thread's diff.
 *
 * Slower than the panel on purpose. The panel is open because someone is
 * reading a diff and wants it to keep up; the banner is mounted on every
 * multi-repo thread view whether or not anyone is looking at the changes, and
 * all it has to get right is a count. A finished turn still lands immediately
 * via `THREAD_CHANGES_CHANNEL`, so this interval only covers mid-turn edits.
 */
export const BANNER_POLL_MS = 15_000;

/** The thread panel action that owns diff and PR. */
export const CHANGES_ACTION_ID = "changes";
export const CHANGES_TAB_TITLE = "Changes";

/** The composer customization, and the banner inside it. */
export const COMPOSER_CUSTOMIZATION_ID = "workspace";
export const CHANGES_BANNER_ID = "changes";

export const ENVIRONMENT_PROVIDER_ID = "multi-repo-workspace";

/**
 * Caps, not budgets.
 *
 * bb's own diff surface tiers, paginates, virtualizes and counts bytes. None
 * of that is built here — the panel caps the file count and the per-file patch
 * size instead and says so in the UI. A workspace whose diff exceeds these is
 * rare enough that "open it in the repo" is a fair answer, and building the
 * hardening before anyone hits the cap would be the expensive half of a diff
 * viewer for no one.
 */
export const MAX_DIFF_FILES = 400;
export const MAX_PATCH_BYTES = 512 * 1024;

/** How long a cached PR read stays fresh before the panel refetches it. */
export const PR_CACHE_TTL_MS = 60_000;

/** How long a cache entry may go unfetched before `create()` refreshes it. */
export const CACHE_FRESH_MS = 10 * 60 * 1000;

/** The background sweep's target freshness, which is looser than a cold start's. */
export const CACHE_BACKGROUND_MS = 60 * 60 * 1000;

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export function changeStatusLabel(status: ChangeStatus): string {
  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
  }
}

/** Tailwind text colors matching bb's own diff gutters, one per status. */
export function changeStatusTone(status: ChangeStatus): string {
  switch (status) {
    case "added":
    case "untracked":
      return "text-green-600 dark:text-green-500";
    case "deleted":
      return "text-red-600 dark:text-red-500";
    case "renamed":
      return "text-blue-600 dark:text-blue-500";
    case "modified":
      return "text-amber-600 dark:text-amber-500";
  }
}

/**
 * `multi-repo.thread-changed`, validated — a realtime payload is `unknown`.
 *
 * Realtime has no per-channel subscriptions, so every thread's signal reaches
 * every subscriber; the `threadId` is how a surface decides the signal says
 * anything about the checkout it is showing.
 */
export function threadSignal(payload: unknown): { threadId: string; pullRequests: boolean } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  return typeof record.threadId === "string"
    ? { threadId: record.threadId, pullRequests: record.pullRequests === true }
    : null;
}
