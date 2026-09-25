import { useCallback, useEffect, useRef, useState } from "react";
import { UrlLink, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { AdvanceBatch, AdvanceJob, AdvancePreview } from "./bulk-advance";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { advanceStatus } from "./bulk-advance-results";
import { advancePreviewAction, advancePreviewSummary } from "./bulk-advance-preview";

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

export function AdvanceProgress({ batches, error, onRefresh, onOpenThread }: {
  batches: AdvanceBatch[]; error: string | null; onRefresh: () => void; onOpenThread: (threadId: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [history, setHistory] = useState(false);
  const act = async (batchId: string, action: "cancel" | "recheck") => {
    setBusy(batchId);
    setActionError(null);
    try {
      if (action === "cancel") await rpc.call("advance_cancel", { batchId });
      else await rpc.call("advance_recheck", { batchId });
      onRefresh();
    } catch (cause) { setActionError(failure(cause)); }
    finally { setBusy(null); }
  };
  if (batches.length === 0 && error === null) return null;
  const visible = history ? batches : batches.slice(0, 1);
  return <section aria-label="Advance batch progress" className="shrink-0 border-b border-border/60 bg-foreground/[0.015] text-[11.5px]">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)} className="rounded text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">{expanded ? "▾" : "▸"} Advance progress</button>
      {batches[0] ? <span className="text-muted-foreground">{batches[0].jobs.filter((job) => job.status === "ready").length} ready · {batches[0].jobs.filter((job) => ACTIVE.has(job.status)).length} in progress · {batches[0].jobs.filter((job) => job.status === "needs-attention").length} need attention{batches[0].jobs.some((job) => job.status === "waiting-checks" || job.status === "waiting-review") ? ` · ${batches[0].jobs.filter((job) => job.status === "waiting-checks" || job.status === "waiting-review").length} waiting` : ""}</span> : null}
      {error === null ? null : <><span role="alert" className="text-destructive">{error}</span><button type="button" className="underline" onClick={onRefresh}>Retry</button></>}
    </div>
    {expanded ? <div className="max-h-[35vh] space-y-3 overflow-y-auto px-4 pb-3">
      {visible.map((batch) => <div key={batch.id} className="rounded-md border border-border bg-background px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">{batch.jobs.length} PRs · {new Date(batch.createdAt).toLocaleString()}</span>
          <button type="button" disabled={busy !== null || !batch.jobs.some((job) => !ACTIVE.has(job.status) && job.status !== "cancelled")} onClick={() => void act(batch.id, "recheck")} className="rounded text-muted-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">{busy === batch.id ? "Updating…" : "Recheck readiness"}</button>
          {batch.jobs.some((job) => job.status === "queued") && !batch.cancelled ? <button type="button" disabled={busy !== null} onClick={() => void act(batch.id, "cancel")} className="rounded text-muted-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">Stop queued PRs</button> : null}
          {batch.cancelled ? <span className="text-muted-foreground">Queue stopped; active work may finish.</span> : null}
        </div>
        <ul className="mt-1 divide-y divide-border/50">
          {batch.jobs.map((job) => <li key={job.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 py-2">
            <UrlLink href={job.prUrl} className="min-w-0 truncate underline-offset-2 hover:underline" title={`${job.repo} #${job.number} (${job.title})`}><span className="font-medium">{job.repo.split("/").at(-1)} <span className="font-mono">#{job.number}</span></span> <span className="text-muted-foreground">{job.title}</span></UrlLink>
            <span className={cn("text-right", job.status === "ready" ? "text-emerald-700 dark:text-emerald-400" : job.status === "needs-attention" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>{advanceStatus(job)}</span>
            <p className="col-span-2 break-words text-[11px] text-muted-foreground">{job.detail}{job.uncertain ? " Worker state is uncertain. Recheck readiness to reconcile this job; inspect its worker before retrying." : ""}{job.checkedHeadOid ? <span className="ml-1 font-mono">· {job.checkedHeadOid.slice(0, 7)}</span> : null}{job.threadId ? <> · <button type="button" onClick={() => onOpenThread(job.threadId!)} className="rounded underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">Open worker</button></> : null}</p>
          </li>)}
        </ul>
      </div>)}
      {actionError === null ? null : <p role="alert" className="text-destructive">{actionError}</p>}
      {batches.length > 1 ? <button type="button" onClick={() => setHistory((current) => !current)} className="rounded text-muted-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">{history ? "Hide previous batches" : `Previous batches · ${batches.length - 1}`}</button> : null}
    </div> : null}
  </section>;
}
