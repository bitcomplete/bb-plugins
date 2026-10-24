// The `sidebar.threadListProvider` preference values, shared by the client
// footer toggle (`app.tsx`) and the server-side default pin (`server.ts`).
// Its own module so the app bundle imports only these strings, never server
// code (BB-45).

/** The UI preference that picks the sidebar thread list. */
export const THREAD_LIST_PROVIDER_KEY = "sidebar.threadListProvider";
/** bb's bundled thread list; pinning to it leaves the sidebar as it was. */
export const BUILTIN_THREAD_LIST_ID = "thread-list/thread-list";
/** What `sidebar.threadListProvider` reads while nothing is pinned. */
export const AUTOMATIC_THREAD_LIST_PROVIDER = "__automatic__";

/** The value that turns the stewards list on: the plugin id plus BB-44's slot id. */
export const stewardsThreadListId = (pluginId: string): string => `${pluginId}/sidebar`;
