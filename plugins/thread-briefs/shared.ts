/**
 * Values both the server and the frontend need at runtime, with no imports.
 *
 * This module exists to keep `@get-bb/plugin-sdk` and zod out of the frontend
 * bundle's dependency graph. `contract.ts` imports `defineRpcContract` from the
 * SDK root, which the app build cannot resolve: the SDK is a devDependency, so
 * a production install prunes it, and only `@get-bb/plugin-sdk/app` is shimmed
 * for the frontend. Any runtime value `app.tsx` needs therefore lives here
 * rather than beside the schemas, so the app's imports from `contract.ts` stay
 * type-only and erase completely.
 */

/** Where the thread is in its arc, in display order. */
export const BRIEF_STAGES = [
  "discovery",
  "planning",
  "implementation",
  "review",
] as const;

export type BriefStage = (typeof BRIEF_STAGES)[number];

/** Realtime channel the server pokes when any brief changes. */
export const BRIEFS_CHANGED_CHANNEL = "briefs-changed";
