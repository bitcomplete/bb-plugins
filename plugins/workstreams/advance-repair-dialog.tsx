import { useEffect, useState } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { AdvanceRepairPlan } from "./bulk-advance";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ThreadSplitButton } from "./thread-split-button";

type Mode = "continue" | "subthread" | "new";
const LABEL: Record<Mode, string> = { continue: "Continue existing worker", subthread: "Child of a linked thread", new: "New thread" };

export function AdvanceRepairDialog({ target, onClose, onStarted, onOpenThread }: {
  target: { batchId: string; jobId: string } | null; onClose: () => void; onStarted: () => void; onOpenThread: (threadId: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [plan, setPlan] = useState<AdvanceRepairPlan | null>(null);
  const [mode, setMode] = useState<Mode>("new");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [revision, setRevision] = useState(0);
  useEffect(() => { setInstruction(""); }, [target]);
  useEffect(() => {
    if (target === null) return;
    let live = true;
    setPlan(null); setError(null); setStarted(null); setBusy(false);
    rpc.call("advance_repair_plan", target).then((next) => {
      if (!live) return;
      setPlan(next); setMode(next.recommendation.mode); setThreadId(next.recommendation.threadId); setClock(Date.now());
    }, (cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [target, revision, rpc]);
  const candidates = plan?.candidates.filter((candidate) => mode === "continue" ? candidate.canContinue : candidate.canSpawnChild) ?? [];
  const expired = plan !== null && plan.expiresAt <= clock;
  const ready = plan !== null && !expired && plan.modes.includes(mode) && (mode === "new" || candidates.some((candidate) => candidate.id === threadId));
  const run = async () => {
    if (!ready || plan === null || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await rpc.call("advance_repair_run", { token: plan.token, mode, threadId: mode === "new" ? null : threadId, instruction: instruction.trim() });
      setStarted(result.threadId); onStarted();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{started ? "Repair started" : "Fix this PR"}</DialogTitle>
        <DialogDescription>{plan ? <UrlLink href={plan.job.prUrl} className="break-words underline underline-offset-2">{plan.job.repo} #{plan.job.number} ({plan.job.title})</UrlLink> : "Read the failure and current PR state, then choose where to continue."}</DialogDescription>
      </DialogHeader>
      {started ? <div className="space-y-3 text-[12px]">
        <p>The repair is tracked on this PR. Stay on the Board to follow its result.</p>
        <div className="flex flex-wrap items-center gap-3"><button type="button" onClick={() => onOpenThread(started)} className="rounded underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">Open thread</button><ThreadSplitButton threadId={started} /></div>
      </div> : plan === null ? error === null ? <p role="status" className="text-[12px] text-muted-foreground">Reading the failure, current PR, and linked threads…</p> : null : <>
        <section className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px]">
          <h3 className="font-medium">What stopped the advance</h3><p className="break-words text-muted-foreground">{plan.job.detail}</p>
          {plan.job.threadId ? <button type="button" onClick={() => onOpenThread(plan.job.threadId!)} className="rounded underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">Open previous worker</button> : null}
        </section>
        <section className="space-y-2 text-[12px]">
          <h3 className="font-medium">Next actions</h3>
          <p className="break-words text-muted-foreground">{plan.fresh.detail}</p>
          <ol className="list-decimal space-y-1 pl-5">{plan.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        </section>
        <div className="space-y-2 text-[12px]">
          <p className="text-muted-foreground">{plan.recommendation.reason}</p>
          <div role="radiogroup" aria-label="Where to repair" className="flex flex-wrap gap-1.5">
            {plan.modes.map((option) => <button key={option} type="button" role="radio" aria-checked={mode === option} disabled={busy} onClick={() => {
              setMode(option);
              const possible = plan.candidates.filter((candidate) => option === "continue" ? candidate.canContinue : candidate.canSpawnChild);
              if (!possible.some((candidate) => candidate.id === threadId)) setThreadId(possible[0]?.id ?? null);
            }} className={cn("rounded-md border px-2.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", mode === option ? "border-foreground/60 bg-foreground/[0.07] font-medium" : "border-border")}>{LABEL[option]}</button>)}
          </div>
          {mode === "new" ? null : <label className="grid gap-1.5">{mode === "continue" ? "Existing worker" : "Parent thread"}
            <select value={threadId ?? ""} disabled={busy} onChange={(event) => setThreadId(event.target.value)} className="h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="" disabled>Choose a linked thread</option>
              {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title} · {candidate.running ? "running" : "idle"}</option>)}
            </select>
          </label>}
        </div>
        <label className="grid gap-1.5 text-[12px]">Additional direction (optional)
          <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} disabled={busy} maxLength={4000} rows={3} placeholder="What should this repair focus on?" className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
      </>}
      {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
      {expired && !started ? <p role="status" className="text-[12px] text-muted-foreground">Refresh this preview before starting.</p> : null}
      <DialogFooter className="flex-wrap gap-2">
        <Button variant="ghost" disabled={busy} onClick={onClose}>{started ? "Stay on Board" : "Cancel"}</Button>
        {!started && (error !== null || expired) ? <Button variant="outline" disabled={busy} onClick={() => setRevision((value) => value + 1)}>Refresh preview</Button> : null}
        {!started ? <Button disabled={!ready || busy} onClick={() => void run()}>{busy ? "Starting…" : mode === "continue" ? "Continue repair" : mode === "subthread" ? "Start child repair" : "Start repair thread"}</Button> : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
