import { z } from "zod";

export const archiveRecordSchema = z.object({
  threadId: z.string(), title: z.string(), ticket: z.string(), archivedAt: z.number(), archivedThreadIds: z.array(z.string()),
});
export type ArchiveRecord = z.infer<typeof archiveRecordSchema>;
export const ARCHIVE_HISTORY_LIMIT = 50;

export type ArchiveSdk = {
  get(args: { threadId: string }): Promise<{ status: string; archivedAt: number | null; deletedAt: number | null }>;
  list(args: { parentThreadId?: string; sourceThreadId?: string; archived: boolean; includeHidden: true; limit: 1 }): Promise<{ id: string }[]>;
  archive(args: { threadId: string }): Promise<{ ok: true; archivedThreadIds: string[] }>;
  unarchive(args: { threadId: string }): Promise<{ ok: true }>;
};

export type ArchiveStore = {
  get(threadId: string): Promise<ArchiveRecord | undefined>;
  set(record: ArchiveRecord): Promise<void>;
  delete(threadId: string): Promise<void>;
  list(): Promise<ArchiveRecord[]>;
};

type Result = { ok: true; detail: string } | { ok: false; error: string };

/** BB archive includes descendants, so this small action only accepts idle leaf threads. */
export async function archiveLinkedThread(
  sdk: ArchiveSdk,
  store: ArchiveStore,
  request: { threadId: string; link: { title: string; ticket: string } | undefined },
): Promise<Result> {
  if (request.link === undefined) return { ok: false, error: "That thread is no longer linked to the board. Refresh and try again." };
  const thread = await sdk.get({ threadId: request.threadId });
  if (thread.deletedAt !== null || thread.archivedAt !== null) return { ok: false, error: "That thread is no longer available to archive." };
  if (thread.status !== "idle") return { ok: false, error: "Only idle threads can be archived here. Wait for this thread to finish." };
  const descendants = await Promise.all([
    sdk.list({ parentThreadId: request.threadId, archived: false, includeHidden: true, limit: 1 }),
    // An archived child can still have live descendants that BB would archive.
    sdk.list({ parentThreadId: request.threadId, archived: true, includeHidden: true, limit: 1 }),
    sdk.list({ sourceThreadId: request.threadId, archived: false, includeHidden: true, limit: 1 }),
  ]);
  if (descendants.some((rows) => rows.length > 0)) {
    return { ok: false, error: "This thread has subthreads. Open it in BB to archive the whole thread family." };
  }
  // A status event can arrive while the family checks run. Re-read just before archiving.
  const current = await sdk.get({ threadId: request.threadId });
  if (current.status !== "idle" || current.archivedAt !== null || current.deletedAt !== null) {
    return { ok: false, error: "That thread changed while checking it. Refresh and try again." };
  }
  const record = { threadId: request.threadId, title: request.link.title, ticket: request.link.ticket, archivedAt: Date.now(), archivedThreadIds: [request.threadId] };
  // Persist before the mutation so an interrupted request still leaves a restore reference.
  await store.set(record);
  const result = await sdk.archive({ threadId: request.threadId });
  // Keep the actual IDs BB returned in case the family changed during the request.
  await store.set({ ...record, archivedThreadIds: result.archivedThreadIds.length > 0 ? result.archivedThreadIds : record.archivedThreadIds });
  const history = (await store.list()).sort((a, b) => b.archivedAt - a.archivedAt);
  await Promise.all(history.slice(ARCHIVE_HISTORY_LIMIT).map((old) => store.delete(old.threadId)));
  return { ok: true, detail: "Thread archived" };
}

/** Restore only an exact ID that Workstreams recorded when archiving. */
export async function restoreArchivedThread(sdk: ArchiveSdk, store: ArchiveStore, threadId: string): Promise<Result> {
  const record = await store.get(threadId);
  if (record === undefined) return { ok: false, error: "This thread was not archived from Workstreams." };
  for (const id of record.archivedThreadIds) {
    const thread = await sdk.get({ threadId: id });
    if (thread.deletedAt !== null) return { ok: false, error: "An archived thread was deleted and cannot be restored." };
    if (thread.archivedAt !== null) await sdk.unarchive({ threadId: id });
  }
  await store.delete(threadId);
  return { ok: true, detail: "Thread restored" };
}
