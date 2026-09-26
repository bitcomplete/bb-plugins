import { useCallback, useEffect, useRef, useState } from "react";
import { UrlLink, experimental_useSidebarThreads, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { AdvanceBatch, AdvanceJob, AdvancePreview } from "./bulk-advance";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { advanceStatus } from "./bulk-advance-results";
import { advancePreviewAction, advancePreviewSummary } from "./bulk-advance-preview";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ThreadMenu } from "./threadmenu";
import { backlogThreads } from "./backlog-threads";
import { canRecheckProgressJob, canRemoveProgressJob, progressBatches, progressCounts } from "./advance-progress";
import { usePortalScopeProps } from "./lib/portal-scope";
import { Icon } from "@/components/ui/icon";

const ACTIVE = new Set<AdvanceJob["status"]>(["queued", "launching", "running", "verifying"]);
const failure = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

/** Saved jobs remain visible after changing Board lenses or reopening Workstreams. */
export function useAdvanceBatches() {
  const rpc = useRpc<typeof rpcContract>();
  const [batches, setBatches] = useState<AdvanceBatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(() => {
    const sequence = ++request.current;
    rpc.call("advance_get", null).then((next) => {
      if (request.current !== sequence) return;
      setBatches(next);
      setError(null);
    }, (cause: unknown) => { if (request.current === sequence) setError(failure(cause)); });
  }, [rpc]);
  useEffect(() => { refresh(); return () => { request.current++; }; }, [refresh]);
  useRealtime("board-changed", refresh);
  const active = batches.some((batch) => batch.jobs.some((job) => ACTIVE.has(job.status) || job.uncertain));
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(interval);
  }, [active, refresh]);
  return { batches, error, refresh, active };
}

export function AdvancePreviewButton({ prUrls, disabled, onStarted }: {
  prUrls: string[]; disabled?: boolean; onStarted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<AdvancePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [clock, setClock] = useState(Date.now());
  const generation = useRef(0);
  const preview = async (urls: string[]) => {
    const sequence = ++generation.current;
    setLoading(true);
    setError(null);
    setPlan(null);
    try {
      const next = await rpc.call("advance_preview", { prUrls: urls });
      if (generation.current === sequence) { setPlan(next); setClock(Date.now()); }
    } catch (cause) { if (generation.current === sequence) setError(failure(cause)); }
    finally { if (generation.current === sequence) setLoading(false); }
  };
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => { window.clearInterval(timer); generation.current++; };
  }, [open]);
  const start = async () => {
    if (plan === null || starting || disabled) return;
    setStarting(true);
    setError(null);
    try {
      await rpc.call("advance_start", { token: plan.token });
      onStarted();
      setOpen(false);
    } catch (cause) { setError(failure(cause)); }
    finally { setStarting(false); }
  };
  const eligible = plan?.jobs.filter((job) => job.eligible) ?? [];
  const summary = advancePreviewSummary(plan?.jobs ?? []);
  const repositories = [...new Set(plan?.jobs.map((job) => job.repo) ?? [])];
  const workers = summary.workers;
  const expired = plan !== null && plan.expiresAt <= clock;
  return <>
    <Button size="sm" disabled={disabled || prUrls.length === 0} onClick={() => {
      const urls = [...prUrls];
      setSelection(urls);
      setOpen(true);
      void preview(urls);
    }}>Advance selected{prUrls.length > 0 ? ` · ${prUrls.length}` : ""}</Button>
    <Dialog open={open} onOpenChange={(next) => { if (!starting) setOpen(next); }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Advance approved PRs</DialogTitle>
          <DialogDescription>Address feedback, prepare branches where needed, and verify current merge readiness.</DialogDescription>
        </DialogHeader>
        {loading ? <p role="status" className="text-[12px] text-muted-foreground">Refreshing {selection.length} selected PRs and checking workspaces…</p> : null}
        {plan === null ? null : <>
          <div className="space-y-1 text-[12px]">
            <p className="font-medium">{summary.agentJobs} with agent · {summary.verifyJobs} verify only · {summary.skipped} skipped</p>
            <p className="text-muted-foreground">{workers === 0 ? "Verification runs without an agent worker." : workers === 1 ? "One repository worker named Rebasing... processes PRs sequentially in separate checkouts." : `${workers} repository workers, each named Rebasing..., process PRs sequentially in separate checkouts.`}</p>
          </div>
          <div className="space-y-3">
            {repositories.map((repo) => <section key={repo} className="rounded-md border border-border px-3 py-2">
              <h3 className="break-words text-[12px] font-semibold">{repo}</h3>
              <ul className="mt-1 divide-y divide-border/50">
                {plan.jobs.filter((job) => job.repo === repo).map((job) => <li key={job.prUrl} className="space-y-1 py-2 text-[11.5px]">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <UrlLink href={job.prUrl} className="min-w-0 flex-1 break-words text-foreground underline-offset-2 hover:underline"><span className="font-mono">#{job.number}</span> {job.title}</UrlLink>
                    <span className={cn("max-w-full shrink-0 break-words rounded px-1.5 py-0.5 text-[10.5px]", job.eligible ? "bg-foreground/[0.06]" : "bg-amber-500/10 text-amber-700 dark:text-amber-300")}>{advancePreviewAction(job)}</span>
                  </div>
                  <p className="break-words text-muted-foreground">{job.detail}</p>
                  {job.eligible && (job.needsPreparation || job.needsFeedback) ? <p className="text-muted-foreground">{job.workspace === "create" ? "Create an isolated checkout" : job.workspace === "existing" ? "Use the matched checkout" : "Workspace unavailable"}{job.needsPreparation && job.baseRefName ? ` · integrate ${job.baseRefName}` : ""}</p> : null}
                </li>)}
              </ul>
            </section>)}
          </div>
          <div className="space-y-1 rounded-md bg-foreground/[0.035] px-3 py-2 text-[11.5px] text-muted-foreground">
            {summary.hasFeedback ? <p>For listed feedback, read reviews and current code, verify fixes already made, and address remaining changes. Check and integrate the current base as needed, test and push changes, reply with evidence, and resolve only feedback verified as addressed.</p> : null}
            {summary.hasPreparation ? <p>Update the listed branches and resolve conflicts, then test and push.</p> : null}
            <p>{summary.agentJobs > 0 ? "Push only when changes are needed, use an exact commit lease for rewritten history, and post a PR summary after pushed changes. " : "This batch only reads readiness. "}Check approval, unresolved feedback, checks, and mergeability against the final commit. No PRs are merged.</p>
          </div>
        </>}
        {error === null ? null : <p role="alert" className="text-[12px] text-destructive">{error}</p>}
        {expired ? <p role="status" className="text-[12px] text-amber-700 dark:text-amber-300">This preview expired. Refresh it before starting.</p> : null}
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="ghost" disabled={starting} onClick={() => setOpen(false)}>Cancel</Button>
          {!loading && (plan === null || expired || error !== null) ? <Button variant="outline" disabled={starting} onClick={() => void preview(selection)}>Refresh preview</Button> : null}
          <Button disabled={disabled || loading || starting || expired || eligible.length === 0} onClick={() => void start()}>{starting ? "Starting…" : summary.agentJobs > 0 ? `Start advance · ${eligible.length}` : `Verify ${eligible.length} ${eligible.length === 1 ? "PR" : "PRs"}`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function AdvanceProgressRow({ batchId, job, compact, liveThreads, busy, onRepair, onOpenThread, onRecheck, onVisibility }: {
  batchId: string; job: AdvanceJob; compact: boolean; liveThreads: Parameters<typeof backlogThreads>[4]; busy: boolean;
  onRepair: (batchId: string, jobId: string) => void; onOpenThread: (threadId: string) => void;
  onRecheck: () => void; onVisibility: (hidden: boolean) => void;
}) {
  const [details, setDetails] = useState(false);
  const portalScope = usePortalScopeProps();
  const label = `${job.repo} #${job.number} (${job.title})`;
  const threads = backlogThreads(job.prUrl, [], [], [job], liveThreads);
  const detailId = `advance-detail-${batchId}-${job.id}`;
  const menuItem = "cursor-pointer rounded px-2 py-1.5 text-[12px] outline-none focus:bg-foreground/[0.06] data-[disabled]:pointer-events-none data-[disabled]:opacity-40";
  return <li data-advance-progress-row className={cn("grid min-w-0 items-center gap-x-3 gap-y-0.5 border-b border-border/40 px-2 py-1.5 text-[12px] hover:bg-foreground/[0.025]", compact ? "grid-cols-[minmax(0,1fr)_9.5rem]" : "grid-cols-[11rem_minmax(0,1fr)_10rem_9.5rem]")}>
    <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-1">
      <button type="button" aria-label={`${details ? "Hide" : "Show"} details for ${label}`} aria-expanded={details} aria-controls={detailId} onClick={() => setDetails((current) => !current)} className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <Icon name="ChevronRight" className={cn("size-3", details && "rotate-90")} />
      </button>
      <UrlLink href={job.prUrl} title={label} className={cn("flex min-w-0 items-baseline gap-1.5 underline-offset-2 hover:underline", job.hiddenFromProgress && "text-muted-foreground")}><span className="truncate font-semibold">{job.repo.split("/").at(-1)}</span><span className="shrink-0 font-mono text-[11px]">#{job.number}</span></UrlLink>
    </div>
    <span title={job.title} className={cn("min-w-0 truncate text-foreground/75", compact ? "col-start-1 row-start-2 pl-6 text-[11px]" : "col-start-2 row-start-1", job.hiddenFromProgress && "text-muted-foreground")}>{job.title}</span>
    <span className={cn("text-[11px]", compact ? "col-start-2 row-start-2 text-right" : "col-start-3 row-start-1", job.hiddenFromProgress ? "text-muted-foreground" : job.status === "ready" ? "text-emerald-700 dark:text-emerald-400" : job.status === "needs-attention" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>{job.hiddenFromProgress ? "Removed" : advanceStatus(job)}</span>
    <div className={cn("flex items-center justify-end gap-1", compact ? "col-start-2 row-start-1" : "col-start-4 row-start-1")}>
      {job.hiddenFromProgress ? <button type="button" disabled={busy} aria-label={`Restore ${label} to progress`} title="Show in progress again; does not requeue work" onClick={() => onVisibility(false)} className="rounded px-2 py-0.5 text-[11px] text-muted-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">Restore</button> : job.status === "needs-attention" ? <button type="button" disabled={busy} aria-label={`Fix ${label}`} onClick={() => onRepair(batchId, job.id)} className="rounded border border-border px-2 py-0.5 text-[11px] outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring">Fix…</button> : null}
      {threads.length > 0 ? <ThreadMenu showAll ariaLabel={`Threads for ${label}`} threads={threads} onOpenThread={onOpenThread} onMore={() => onOpenThread(threads[0]!.id)} className={cn("flex h-6 shrink-0 items-center rounded px-1 text-[10.5px] outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring", threads.some((thread) => thread.active) ? "text-sky-700 dark:text-sky-400" : "text-muted-foreground")}>Threads {threads.length}</ThreadMenu> : null}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild><button type="button" aria-label={`More actions for ${label}`} className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Icon name="MoreHorizontal" className="size-3.5" /></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content {...portalScope} side="bottom" align="end" sideOffset={4} collisionPadding={8} className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
          <DropdownMenu.Item aria-label={`${details ? "Hide" : "Show"} details for ${label}`} className={menuItem} onSelect={() => setDetails((current) => !current)}>{details ? "Hide details" : "Show details"}</DropdownMenu.Item>
          {!job.hiddenFromProgress ? <DropdownMenu.Item aria-label={`Recheck readiness for ${label}`} className={menuItem} disabled={busy || !canRecheckProgressJob(job)} onSelect={onRecheck}>Recheck readiness</DropdownMenu.Item> : null}
          {job.hiddenFromProgress ? <DropdownMenu.Item aria-label={`Restore ${label} to progress`} className={menuItem} disabled={busy} onSelect={() => onVisibility(false)}>Restore to progress</DropdownMenu.Item> : canRemoveProgressJob(job) ? <DropdownMenu.Item aria-label={`Remove ${label} from ${job.status === "queued" ? "queue" : "progress"}`} className={menuItem} disabled={busy} onSelect={() => onVisibility(true)}>{job.status === "queued" ? "Remove from queue" : "Remove from progress"}</DropdownMenu.Item> : null}
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
    {details ? <div id={detailId} className="col-span-full min-w-0 space-y-1 pb-1 pl-6 pt-1 text-[11px] text-muted-foreground">
      <p className="break-words font-medium text-foreground/80">{job.title}</p>
      <p className="whitespace-pre-wrap break-words">{job.detail}</p>
      {job.uncertain ? <p>Worker state is uncertain. Inspect its thread and recheck readiness before retrying.</p> : null}
      {job.hiddenFromProgress ? <p>Removed from progress. Restoring shows this record again without requeueing work.</p> : null}
      <p className="flex flex-wrap gap-x-3 gap-y-1">{job.checkedHeadOid ? <span>Checked commit <span className="break-all font-mono">{job.checkedHeadOid}</span></span> : null}<span>Updated {new Date(job.updatedAt).toLocaleString()}</span></p>
    </div> : null}
  </li>;
}

export function AdvanceProgress({ batches, error, onRefresh, onOpenThread, onRepair, width }: {
  batches: AdvanceBatch[]; error: string | null; onRefresh: () => void; onOpenThread: (threadId: string) => void; onRepair: (batchId: string, jobId: string) => void; width: number;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const liveThreads = experimental_useSidebarThreads().threads;
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [history, setHistory] = useState(false);
  const [removedOpen, setRemovedOpen] = useState<Record<string, boolean>>({});
  const act = async (batchId: string, action: "cancel" | "recheck" | "hide" | "restore", jobId?: string) => {
    setBusy(jobId ?? batchId);
    setActionError(null);
    try {
      if (action === "cancel") await rpc.call("advance_cancel", { batchId });
      else if (action === "recheck") await rpc.call("advance_recheck", { batchId, ...(jobId ? { jobId } : {}) });
      else await rpc.call("advance_progress_visibility", { batchId, jobId: jobId!, hidden: action === "hide" });
      onRefresh();
    } catch (cause) { setActionError(failure(cause)); }
    finally { setBusy(null); }
  };
  if (batches.length === 0 && error === null) return null;
  const visible = progressBatches(batches, history);
  const counts = progressCounts(visible.flatMap((batch) => batch.jobs));
  const previous = batches.length - progressBatches(batches, false).length;
  return <section aria-label="Advance batch progress" className="shrink-0 border-b border-border/60 bg-foreground/[0.015] text-[11.5px]">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)} className="rounded text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">{expanded ? "▾" : "▸"} Advance progress</button>
      <span className="text-muted-foreground">{counts.ready} ready · {counts.active} in progress · {counts.attention} need attention{counts.waiting > 0 ? ` · ${counts.waiting} waiting` : ""}</span>
      {error === null ? null : <><span role="alert" className="text-destructive">{error}</span><button type="button" className="underline" onClick={onRefresh}>Retry</button></>}
    </div>
    {expanded ? <div className="max-h-[35vh] overflow-y-auto px-4 pb-2">
      <div className="mx-auto w-full max-w-6xl">
      {visible.map((batch) => {
        const hidden = batch.jobs.filter((job) => job.hiddenFromProgress).length;
        const shown = batch.jobs.filter((job) => !job.hiddenFromProgress || removedOpen[batch.id]);
        return <section key={batch.id} aria-label={`Advance batch ${new Date(batch.createdAt).toLocaleString()}`} className="pt-1.5 first:pt-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 text-[10.5px] text-muted-foreground">
            <span>{batch.jobs.length - hidden} PRs · {new Date(batch.createdAt).toLocaleString()}</span>
            <button type="button" disabled={busy !== null || !batch.jobs.some((job) => !job.hiddenFromProgress && canRecheckProgressJob(job))} onClick={() => void act(batch.id, "recheck")} className="rounded underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">Recheck all</button>
            {batch.jobs.some((job) => !job.hiddenFromProgress && job.status === "queued") && !batch.cancelled ? <button type="button" disabled={busy !== null} onClick={() => void act(batch.id, "cancel")} className="rounded underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">Stop queued PRs</button> : null}
            {hidden > 0 ? <button type="button" aria-expanded={removedOpen[batch.id] ?? false} onClick={() => setRemovedOpen((current) => ({ ...current, [batch.id]: !current[batch.id] }))} className="rounded underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">{removedOpen[batch.id] ? "Hide removed" : `Show removed · ${hidden}`}</button> : null}
            {batch.cancelled ? <span>Queue stopped; active work may finish.</span> : null}
          </div>
          <ul>{shown.map((job) => <AdvanceProgressRow key={job.id} batchId={batch.id} job={job} compact={width < 1060} liveThreads={liveThreads} busy={busy !== null} onRepair={onRepair} onOpenThread={onOpenThread} onRecheck={() => void act(batch.id, "recheck", job.id)} onVisibility={(hidden) => void act(batch.id, hidden ? "hide" : "restore", job.id)} />)}</ul>
          {shown.length === 0 ? <p className="px-2 py-1 text-[11px] text-muted-foreground">All items removed from progress.</p> : null}
        </section>;
      })}
      {actionError === null ? null : <p role="alert" className="px-2 py-1 text-destructive">{actionError}</p>}
      {previous > 0 ? <button type="button" onClick={() => setHistory((current) => !current)} className="mt-2 rounded px-2 text-[10.5px] text-muted-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">{history ? "Hide previous batches" : `Previous batches · ${previous}`}</button> : null}
      </div>
    </div> : null}
  </section>;
}
