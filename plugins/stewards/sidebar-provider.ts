// The `sidebar.threadListProvider` and `sidebar.navigationProvider`
// preference values, shared by the client footer toggle (`app.tsx`) and the
// server-side default pin (`server.ts`). Its own module so the app bundle
// imports only these strings, never server code (BB-45, BB-184).

/** The UI preference that picks the sidebar thread list. */
export const THREAD_LIST_PROVIDER_KEY = "sidebar.threadListProvider";
/** bb's bundled thread list; pinning to it leaves the sidebar as it was. */
export const BUILTIN_THREAD_LIST_ID = "thread-list/thread-list";
/** What `sidebar.threadListProvider` reads while nothing is pinned. */
export const AUTOMATIC_THREAD_LIST_PROVIDER = "__automatic__";

/** The value that turns the stewards list on: the plugin id plus BB-44's slot id. */
export const stewardsThreadListId = (pluginId: string): string => `${pluginId}/sidebar`;

/** The UI preference that picks the sidebar navigation. */
export const NAVIGATION_PROVIDER_KEY = "sidebar.navigationProvider";
/** bb's bundled navigation; Automatic resolves to it with no other provider. */
export const BUILTIN_NAVIGATION_ID = "navigation/rail";
/** What `sidebar.navigationProvider` reads while nothing is pinned. */
export const AUTOMATIC_NAVIGATION_PROVIDER = "__automatic__";

/** The value that turns the stewards navigation on: the plugin id plus BB-184's slot id. */
export const stewardsNavigationId = (pluginId: string): string => `${pluginId}/navigation`;
