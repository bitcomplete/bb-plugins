import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { ArchiveRecord } from "./threadarchive";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";

export function ArchivedThreadsButton() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" aria-label="Archived threads" title="Archived threads" onClick={() => setOpen(true)}
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <Icon name="Archive" className="size-3.5" />
    </button>
    <ArchivedThreadsDialog open={open} onOpenChange={setOpen} />
  </>;
}

/** Independent of linked-thread rows so the last thread can always be restored. */
export function ArchivedThreadsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [records, setRecords] = useState<ArchiveRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setError(null);
    rpc.call("thread_archived", {}).then((items) => { if (current) setRecords(items); },
      () => { if (current) setError("Could not load archived threads. Close this panel and try again."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open, rpc]);
  const restore = async (record: ArchiveRecord) => {
    setBusy(record.threadId);
    setError(null);
    try {
      const result = await rpc.call("thread_restore", { threadId: record.threadId });
      if (!result.ok) { setError(result.error); return; }
      setRecords((items) => items.filter((item) => item.threadId !== record.threadId));
      toast.success(result.detail, { description: record.title });
    } catch {
      setError("Could not restore this thread. Try again.");
    } finally { setBusy(null); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Archived threads</DialogTitle>
        <DialogDescription>The last 50 threads archived from Workstreams. Restoring makes a thread visible again without starting the agent.</DialogDescription>
      </DialogHeader>
      {error === null ? null : <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading ? <p className="text-sm text-muted-foreground">Loading threads…</p> : records.length === 0 ?
        <p className="text-sm text-muted-foreground">No threads archived from Workstreams.</p> :
        <ul className="max-h-[50vh] space-y-1 overflow-y-auto">
          {records.map((record) => <li key={record.threadId} className="flex items-center gap-3 rounded-md px-1 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={record.title}>{record.title}</p>
              <p className="text-xs text-muted-foreground">{record.ticket}{record.archivedThreadIds.length > 1 ? ` · ${record.archivedThreadIds.length} threads` : ""}</p>
            </div>
            <button type="button" disabled={busy !== null} onClick={() => void restore(record)}
              aria-label={`Restore ${record.title}`}
              className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              {busy === record.threadId ? "Restoring…" : "Restore"}
            </button>
          </li>)}
        </ul>}
    </DialogContent>
  </Dialog>;
}
