// The plugin's realtime channels, in their own module so the app bundle
// imports only the strings and never server code (BB-46).

/**
 * Published as `{ projectId }` whenever a project's sidebar- or
 * board-visible steward state changes: the "needs you" set (a question
 * opened or answered, an escalation forwarded to the user or resolved, or a
 * needs item filed, updated or closed) and the rest of the row (a stage,
 * phase, hold, status report, requeue time, deployment state, title, link or
 * ending, or a worker starting or finishing). Every sidebar, board page and
 * the overview refetch on it; the half-minute poll is the fallback.
 *
 * The channel string stays `needs-you-changed` (BB-90): it was published
 * under that name before the signal widened, and a server and client built
 * from different images must keep talking across a restart.
 */
export const PROJECT_CHANGED = "needs-you-changed";
