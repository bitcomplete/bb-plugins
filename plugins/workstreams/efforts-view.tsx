import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UrlLink, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { Board, rpcContract } from "./server";
import type { EstablishedEffort } from "./effort-store";
import type { effortAdminPreviewSchema } from "./effort-admin";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type MergePreview = z.infer<typeof effortAdminPreviewSchema>;

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const counts = (effort: EstablishedEffort) => [
  `${effort.members.tickets.length} tickets`,
  `${effort.members.prUrls.length} PRs`,
  `${effort.members.checkoutPaths?.length ?? 0} checkouts`,
].join(" · ");
const inactive = (effort: EstablishedEffort) => effort.archivedAt != null || effort.mergedInto != null;

export function EffortsView({ board }: { board: Board | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const createRequest = useRef<{ name: string; goal: string; id: string } | null>(null);
  const [wide, setWide] = useState(false);
  const [efforts, setEfforts] = useState<EstablishedEffort[]>([]);
  const [scopes, setScopes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [editScope, setEditScope] = useState("");
  const [destinationKey, setDestinationKey] = useState("");
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? node.clientWidth) >= 900));
    observer.observe(node);
    setWide(node.clientWidth >= 900);
    return () => observer.disconnect();
  }, []);

  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const result = await rpc.call("effort_admin_list", null);
      if (current !== request.current) return;
      setEfforts(result.efforts);
      setScopes(result.scopes);
      setLoadError(null);
      return result;
    } catch (cause) {
      if (current === request.current) setLoadError(message(cause));
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [rpc]);
  useEffect(() => {
    void refresh();
    return () => { request.current++; };
  }, [refresh]);
  useRealtime("board-changed", refresh);

  const selected = efforts.find((effort) => effort.key === selectedKey) ?? null;
  const active = efforts.filter((effort) => !inactive(effort)).sort((a, b) => b.updatedAt - a.updatedAt);
  const historical = efforts.filter(inactive).sort((a, b) => b.updatedAt - a.updatedAt);
  const destinations = active.filter((effort) => effort.key !== selectedKey);
  const hasDetail = creating || selected !== null;
  const mergedDestination = selected?.mergedInto ? efforts.find((effort) => effort.id === selected.mergedInto) : null;
  const prLabels = useMemo(() => {
    const labels = new Map<string, string>();
    if (!board) return labels;
    for (const entry of board.prInventory.entries) labels.set(entry.pr.url.toLowerCase(), `${entry.repo} #${entry.pr.number} · ${entry.pr.title}`);
    for (const group of board.groups) for (const cluster of group.clusters) for (const unit of cluster.units) {
      if (unit.pr) labels.set(unit.pr.url.toLowerCase(), `${unit.repo ?? unit.dirName} #${unit.pr.number} · ${unit.pr.title}`);
    }
    return labels;
  }, [board]);

  const select = (effort: EstablishedEffort) => {
    setSelectedKey(effort.key);
    setCreating(false);
    setName(effort.name);
    setGoal(effort.goal);
    setEditScope(scopes[effort.key] ?? "");
    setDestinationKey("");
    setPreview(null);
    setError(null);
    setNotice(null);
  };
  const startCreate = () => {
    setSelectedKey(null);
    setCreating(true);
    setName("");
    setGoal("");
    createRequest.current = null;
    setError(null);
    setNotice(null);
  };
  const closeDetail = () => {
    setSelectedKey(null);
    setCreating(false);
    setError(null);
    setNotice(null);
  };
  const reloadDetails = async () => {
    const list = await refresh();
    const current = list?.efforts.find((effort) => effort.key === selectedKey);
    if (!current) return;
    setName(current.name);
    setGoal(current.goal);
    setEditScope(list?.scopes[current.key] ?? "");
    setError(null);
  };

  const save = async () => {
    if (busy || !name.trim() || !creating && selected === null) return;
    setBusy(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      const trimmedGoal = goal.trim();
      if (creating && (createRequest.current?.name !== trimmedName || createRequest.current.goal !== trimmedGoal)) {
        createRequest.current = { name: trimmedName, goal: trimmedGoal, id: crypto.randomUUID() };
      }
      const result = creating
        ? await rpc.call("effort_admin_create", { name: trimmedName, goal: trimmedGoal, requestId: createRequest.current!.id })
        : await rpc.call("effort_admin_update", { effortKey: selected!.key, name: trimmedName, goal: trimmedGoal, expectedScope: editScope });
      if (!result.ok) { setError(result.error); return; }
      setCreating(false);
      createRequest.current = null;
      setSelectedKey(result.effort.key);
      setName(result.effort.name);
      setGoal(result.effort.goal);
      setNotice(result.notice ?? (creating ? "Effort created." : "Effort updated."));
      const list = await refresh();
      setEditScope(list?.scopes[result.effort.key] ?? "");
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };

  const setArchived = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("effort_admin_archive", {
        effortKey: selected.key, archived: selected.archivedAt == null, expectedScope: editScope,
      });
      if (!result.ok) { setError(result.error); return; }
      setNotice(result.effort.archivedAt == null ? "Effort restored." : "Effort archived.");
      const list = await refresh();
      setEditScope(list?.scopes[result.effort.key] ?? "");
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };

  const reviewMerge = async () => {
    if (!selected || !destinationKey || previewing) return;
    setPreviewing(true);
    setError(null);
    setPreview(null);
    try {
      const result = await rpc.call("effort_admin_merge_preview", { sourceKey: selected.key, destinationKey });
      if (!result.ok) { setError(result.error); return; }
      setPreview(result.preview);
      setPreviewOpen(true);
    } catch (cause) { setError(message(cause)); }
    finally { setPreviewing(false); }
  };

  const merge = async () => {
    if (!preview || busy || preview.blockers.length) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("effort_admin_merge", {
        sourceKey: preview.source.key, destinationKey: preview.destination.key, expectedScope: preview.scope,
      });
      if (!result.ok) { setError(result.error); setPreviewOpen(false); return; }
      setPreviewOpen(false);
      setPreview(null);
      const nextKey = result.pendingThreadSync ? preview.source.key : result.effort.key;
      setSelectedKey(nextKey);
      setDestinationKey("");
      setNotice(result.notice ?? `Merged into ${result.effort.name}. Existing thread histories remain available.`);
      const list = await refresh();
      const next = list?.efforts.find((effort) => effort.key === nextKey) ?? (result.pendingThreadSync ? preview.source : result.effort);
      setName(next.name);
      setGoal(next.goal);
      setEditScope(list?.scopes[nextKey] ?? "");
    } catch (cause) { setError(message(cause)); setPreviewOpen(false); }
    finally { setBusy(false); }
  };

  const retryThreadSync = async () => {
    if (!selected || !mergedDestination || busy) return;
    setBusy(true);
    setError(null);
    try {
      const review = await rpc.call("effort_admin_merge_preview", { sourceKey: selected.key, destinationKey: mergedDestination.key });
      if (!review.ok) { setError(review.error); return; }
      if (review.preview.blockers.length) { setError(review.preview.blockers.join(" ")); return; }
      if (!review.preview.pendingThreadSync) { setNotice("Thread assignments are up to date."); return; }
      const result = await rpc.call("effort_admin_merge", {
        sourceKey: selected.key, destinationKey: mergedDestination.key, expectedScope: review.preview.scope,
      });
      if (!result.ok) { setError(result.error); return; }
      setNotice(result.notice ?? "Thread assignments are up to date.");
      await refresh();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };

  const effortRow = (effort: EstablishedEffort) => <li key={effort.key} className="flex min-w-0 items-center gap-2 border-b border-border/60 px-4 py-2.5">
    <button type="button" onClick={() => select(effort)} aria-current={selectedKey === effort.key ? "true" : undefined}
      className={cn("min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", selectedKey === effort.key && "text-foreground") }>
      <span className="flex min-w-0 items-baseline gap-2"><span className="truncate text-[13px] font-medium">{effort.name}</span>
        {effort.mergedInto ? <span className="shrink-0 text-[10px] text-muted-foreground">Merged</span> : effort.archivedAt ? <span className="shrink-0 text-[10px] text-muted-foreground">Archived</span> : null}</span>
      {effort.goal ? <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{effort.goal}</span> : null}
      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{counts(effort)}</span>
    </button>
    {effort.coordinatorThreadId ? <button type="button" onClick={() => navigate.toThread(effort.coordinatorThreadId!)}
      aria-label={`Open coordinator thread for ${effort.name}`} title="Open coordinator thread"
      className="shrink-0 rounded px-1.5 py-1 text-[11px] text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Thread</button> : null}
  </li>;

  return <div ref={rootRef} className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
    <div className="flex min-h-0 flex-1">
      <main className={cn("min-w-0 overflow-y-auto overscroll-contain", hasDetail && !wide ? "hidden" : wide && hasDetail ? "w-[42%] border-r border-border/70" : "flex-1")}>
        <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-5">
          <div><h1 className="text-[20px] font-semibold tracking-tight">Efforts</h1><p className="mt-0.5 text-[11px] text-muted-foreground">{efforts.length} saved · {active.length} active</p></div>
          <Button type="button" size="sm" onClick={startCreate}>New effort</Button>
        </div>
        {loadError ? <p role="alert" className="px-4 pb-3 text-[11px] text-destructive">Could not load efforts: {loadError} <button type="button" onClick={() => void refresh()} className="underline">Retry</button></p> : null}
        {loading ? <p role="status" className="px-4 py-5 text-[12px] text-muted-foreground">Loading efforts…</p> : active.length ? <ul className="border-t border-border/60">{active.map(effortRow)}</ul> : <p className="border-t border-border/60 px-4 py-6 text-[12px] text-muted-foreground">No active saved efforts. Create one to give related work a name and goal.</p>}
        {historical.length ? <section className="mt-4 border-t border-border/70">
          <button type="button" aria-expanded={showInactive} onClick={() => setShowInactive((value) => !value)}
            className="w-full px-4 py-3 text-left text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">{showInactive ? "Hide" : "Show"} archived and merged · {historical.length}</button>
          {showInactive ? <ul className="border-t border-border/60">{historical.map(effortRow)}</ul> : null}
        </section> : null}
      </main>
      {hasDetail ? <aside aria-label={creating ? "Create effort" : `${selected?.name} details`}
        className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8 pt-4">
        {!wide ? <button type="button" onClick={closeDetail} className="mb-4 text-[12px] text-muted-foreground underline-offset-2 hover:underline">← All efforts</button> : null}
        <h2 className="text-[17px] font-semibold tracking-tight">{creating ? "New effort" : selected?.name}</h2>
        {selected?.mergedInto ? <p className="mt-2 text-[12px] text-muted-foreground">Merged into {mergedDestination ? <button type="button" onClick={() => select(mergedDestination)} className="font-medium underline underline-offset-2">{mergedDestination.name}</button> : "another effort"}. Its thread history remains available.</p> : null}
        {selected?.mergedInto && mergedDestination ? <button type="button" disabled={busy} onClick={() => void retryThreadSync()}
          className="mt-2 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{busy ? "Checking thread sync…" : "Retry thread sync"}</button> : null}
        {selected?.archivedAt && !selected.mergedInto ? <p className="mt-2 text-[12px] text-muted-foreground">Archived. Restore it to assign new work.</p> : null}
        {notice ? <p role="status" className="mt-3 text-[11px] text-muted-foreground">{notice}</p> : null}
        {error ? <p role="alert" className="mt-3 text-[11px] text-destructive">{error} {selected ? <button type="button" onClick={() => void reloadDetails()} className="underline">Reload details</button> : null}</p> : null}
        {selected && !selected.mergedInto ? <button type="button" onClick={() => navigate.toPluginPanel("board", { subPath: `deck/${encodeURIComponent(selected.id)}` })}
          className="mr-4 mt-3 text-[12px] font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">Open card</button> : null}
        {selected?.coordinatorThreadId ? <button type="button" onClick={() => navigate.toThread(selected.coordinatorThreadId!)}
          className="mt-3 text-[12px] font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">Open coordinator thread</button> : null}
        <div className="mt-5 max-w-xl space-y-4">
          <label className="grid gap-1.5 text-[12px] font-medium">Name
            <input value={name} onChange={(event) => setName(event.target.value)} disabled={busy || Boolean(selected?.mergedInto)} maxLength={120}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-[12px] font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" />
          </label>
          <label className="grid gap-1.5 text-[12px] font-medium">Goal
            <textarea value={goal} onChange={(event) => setGoal(event.target.value)} disabled={busy || Boolean(selected?.mergedInto)} maxLength={4000} rows={3}
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-[12px] font-normal leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" />
          </label>
          {!selected?.mergedInto ? <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? "Saving…" : creating ? "Create effort" : "Save changes"}</Button>
            {selected ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void setArchived()}>{selected.archivedAt ? "Restore" : "Archive"}</Button> : null}</div> : null}
        </div>
        {selected ? <section className="mt-8 max-w-xl border-t border-border/70 pt-5">
          <h3 className="text-[12px] font-semibold">Linked work</h3>
          <p className="mt-1 text-[11px] text-muted-foreground">{counts(selected)}</p>
          {selected.members.tickets.length ? <p className="mt-3 break-words text-[11px] text-muted-foreground">{selected.members.tickets.join(" · ")}</p> : null}
          {selected.members.prUrls.length ? <details className="mt-3 text-[11px]"><summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">Pull requests · {selected.members.prUrls.length}</summary>
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">{selected.members.prUrls.map((url) => <li key={url}><UrlLink href={url} className="break-words underline-offset-2 hover:underline">{prLabels.get(url.toLowerCase()) ?? url}</UrlLink></li>)}</ul>
          </details> : null}
        </section> : null}
        {selected && !inactive(selected) ? <section className="mt-8 max-w-xl border-t border-border/70 pt-5">
          <h3 className="text-[12px] font-semibold">Merge into another effort</h3>
          <p className="mt-1 text-[11px] text-muted-foreground">Review the work and threads that move before confirming.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="effort-merge-destination">Destination effort</label>
            <select id="effort-merge-destination" value={destinationKey} onChange={(event) => { setDestinationKey(event.target.value); setPreview(null); }}
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="">Choose destination…</option>
              {destinations.map((effort) => <option key={effort.key} value={effort.key}>{effort.name}</option>)}
            </select>
            <Button type="button" size="sm" variant="outline" disabled={!destinationKey || previewing || busy} onClick={() => void reviewMerge()}>{previewing ? "Reviewing…" : "Review merge"}</Button>
          </div>
        </section> : null}
      </aside> : null}
    </div>
    <Dialog open={previewOpen} onOpenChange={(open) => { if (!busy) setPreviewOpen(open); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>Merge efforts</DialogTitle><DialogDescription>Review this transfer before confirming.</DialogDescription></DialogHeader>
        {preview ? <div className="space-y-4 text-[12px]">
          <p><strong>{preview.source.name}</strong> → <strong>{preview.destination.name}</strong></p>
          <p className="text-muted-foreground">Move {preview.members.tickets} tickets, {preview.members.prUrls} PRs, and {preview.members.checkoutPaths} checkouts. The source is marked merged. Existing thread histories remain available.</p>
          <section><h3 className="font-semibold">Affected threads · {preview.threads.length}</h3>
            {preview.threads.length ? <ul className="mt-1 max-h-40 overflow-y-auto border-t border-border/60">{preview.threads.map((thread) => <li key={thread.id} className="flex items-baseline justify-between gap-2 border-b border-border/60 py-1.5"><button type="button" onClick={() => navigate.toThread(thread.id)} className="min-w-0 truncate text-left underline-offset-2 hover:underline">{thread.title || thread.id}</button><span className="shrink-0 text-[10px] text-muted-foreground">{thread.role} · {thread.status}</span></li>)}</ul> : <p className="mt-1 text-muted-foreground">No linked threads.</p>}</section>
          {preview.conflicts.length ? <section><h3 className="font-semibold">Thread routing</h3><ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">{preview.conflicts.map((line, index) => <li key={index}>{line}</li>)}</ul></section> : null}
          {preview.blockers.length ? <section role="alert"><h3 className="font-semibold text-destructive">Cannot merge yet</h3><ul className="mt-1 list-disc space-y-1 pl-4">{preview.blockers.map((line, index) => <li key={index}>{line}</li>)}</ul></section> : null}
        </div> : null}
        <DialogFooter><Button type="button" variant="outline" onClick={() => setPreviewOpen(false)} disabled={busy}>Cancel</Button>
          <Button type="button" disabled={!preview || busy || Boolean(preview.blockers.length)} onClick={() => void merge()}>{busy ? "Merging…" : "Merge efforts"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
