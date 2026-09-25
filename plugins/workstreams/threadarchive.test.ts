import { describe, expect, it, vi } from "vitest";
import { archiveLinkedThread, restoreArchivedThread, type ArchiveRecord, type ArchiveSdk, type ArchiveStore } from "./threadarchive.js";

function fixture() {
  const records = new Map<string, ArchiveRecord>();
  const sdk: ArchiveSdk = {
    get: vi.fn(async () => ({ status: "idle", archivedAt: null, deletedAt: null })),
    list: vi.fn(async () => []),
    archive: vi.fn(async ({ threadId }: { threadId: string }) => ({ ok: true as const, archivedThreadIds: [threadId] })),
    unarchive: vi.fn(async () => ({ ok: true as const })),
  };
  const store: ArchiveStore = {
    get: async (id) => records.get(id),
    set: async (record) => { records.set(record.threadId, record); },
    delete: async (id) => { records.delete(id); },
    list: async () => [...records.values()],
  };
  return { sdk, store, records };
}
const request = { threadId: "thr_linked", link: { title: "Fix card balance", ticket: "INK-123" } };

describe("archiveLinkedThread", () => {
  it("refuses unrelated IDs without reading or mutating BB", async () => {
    const { sdk, store } = fixture();
    expect(await archiveLinkedThread(sdk, store, { ...request, link: undefined })).toMatchObject({ ok: false });
    expect(sdk.get).not.toHaveBeenCalled();
    expect(sdk.archive).not.toHaveBeenCalled();
  });

  it.each(["active", "starting", "stopping", "pending", "error"])("never archives a thread with %s status", async (status) => {
    const { sdk, store } = fixture();
    vi.mocked(sdk.get).mockResolvedValue({ status, archivedAt: null, deletedAt: null });
    expect(await archiveLinkedThread(sdk, store, request)).toMatchObject({ ok: false });
    expect(sdk.archive).not.toHaveBeenCalled();
  });

  it.each(["parentThreadId", "sourceThreadId"])("refuses %s descendants because BB archive would include them", async (field) => {
    const { sdk, store } = fixture();
    vi.mocked(sdk.list).mockImplementation(async (args) => field in args ? [{ id: "thr_child" }] : []);
    expect(await archiveLinkedThread(sdk, store, request)).toMatchObject({ ok: false, error: expect.stringContaining("subthreads") });
    expect(sdk.archive).not.toHaveBeenCalled();
  });

  it("retains the exact ID and association before the archive removes it from the board", async () => {
    const { sdk, store, records } = fixture();
    vi.mocked(sdk.archive).mockImplementation(async ({ threadId }) => {
      expect(records.get(threadId)).toMatchObject({ ...request.link, threadId });
      return { ok: true, archivedThreadIds: [threadId] };
    });
    expect(await archiveLinkedThread(sdk, store, request)).toEqual({ ok: true, detail: "Thread archived" });
    vi.mocked(sdk.get).mockResolvedValue({ status: "idle", archivedAt: 123, deletedAt: null });
    expect(await restoreArchivedThread(sdk, store, request.threadId)).toEqual({ ok: true, detail: "Thread restored" });
    expect(sdk.unarchive).toHaveBeenCalledWith({ threadId: request.threadId });
    expect(records.size).toBe(0);
  });

  it("keeps restore available if an archive response is lost", async () => {
    const { sdk, store, records } = fixture();
    vi.mocked(sdk.archive).mockRejectedValue(new Error("Disconnected"));
    await expect(archiveLinkedThread(sdk, store, request)).rejects.toThrow("Disconnected");
    expect(records.has(request.threadId)).toBe(true);
  });

  it("rejects restore requests for IDs Workstreams has never archived", async () => {
    const { sdk, store } = fixture();
    expect(await restoreArchivedThread(sdk, store, "thr_unrelated")).toMatchObject({ ok: false });
    expect(sdk.unarchive).not.toHaveBeenCalled();
  });

  it("rechecks idle status after descendant reads before mutating", async () => {
    const { sdk, store } = fixture();
    vi.mocked(sdk.get).mockResolvedValueOnce({ status: "idle", archivedAt: null, deletedAt: null })
      .mockResolvedValueOnce({ status: "active", archivedAt: null, deletedAt: null });
    expect(await archiveLinkedThread(sdk, store, request)).toMatchObject({ ok: false });
    expect(sdk.archive).not.toHaveBeenCalled();
  });

  it("rejects an archived child because it may own live descendants", async () => {
    const { sdk, store } = fixture();
    vi.mocked(sdk.list).mockImplementation(async (args) => args.archived && args.parentThreadId ? [{ id: "thr_archived_child" }] : []);
    expect(await archiveLinkedThread(sdk, store, request)).toMatchObject({ ok: false });
    expect(sdk.archive).not.toHaveBeenCalled();
  });

  it("restores the actual archived IDs if BB's family changes during the archive", async () => {
    const { sdk, store, records } = fixture();
    vi.mocked(sdk.archive).mockResolvedValue({ ok: true, archivedThreadIds: [request.threadId, "thr_child"] });
    await archiveLinkedThread(sdk, store, request);
    expect(records.get(request.threadId)?.archivedThreadIds).toEqual([request.threadId, "thr_child"]);
    vi.mocked(sdk.get).mockResolvedValue({ status: "idle", archivedAt: 123, deletedAt: null });
    await restoreArchivedThread(sdk, store, request.threadId);
    expect(sdk.unarchive).toHaveBeenCalledWith({ threadId: request.threadId });
    expect(sdk.unarchive).toHaveBeenCalledWith({ threadId: "thr_child" });
  });

  it("bounds Workstreams history while BB retains the archived threads", async () => {
    const { sdk, store, records } = fixture();
    for (let i = 0; i < 50; i++) records.set(`old${i}`, { threadId: `old${i}`, title: "Old", ticket: "INK", archivedAt: i, archivedThreadIds: [`old${i}`] });
    await archiveLinkedThread(sdk, store, request);
    expect(records.size).toBe(50);
    expect(records.has("old0")).toBe(false);
    expect(records.has(request.threadId)).toBe(true);
  });
});
