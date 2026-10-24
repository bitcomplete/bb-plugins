// The plugin's realtime channels, in their own module so the app bundle
// imports only the strings and never server code (BB-46).

/**
 * Published as `{ projectId }` whenever a project's "needs you" set changes:
 * a question opened or answered, an escalation forwarded to the user or
 * resolved, or a needs item filed, updated or closed. Every sidebar and the
 * board page refetch on it; the half-minute poll is the fallback.
 */
export const NEEDS_YOU_CHANGED = "needs-you-changed";
