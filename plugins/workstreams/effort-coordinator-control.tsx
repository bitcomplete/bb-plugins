import { useEffect, useMemo, useState } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { Board, rpcContract } from "./server";
import type { EffortPlan } from "./effort-coordinator";
import type { EstablishedEffort } from "./effort-store";
import { effortTitle } from "./effort-title";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { POINTER_CURSORS, cn } from "@/lib/utils";

type ReadyPlan = Extract<EffortPlan, { ok: true }>;

/** An effort owns a planning thread; its presence is never a PR result or merge gate. */
export function EffortCoordinatorControl({ groupKey, name, effort, board, onOpenThread, onCoordinated }: {
  groupKey: string;
  name: string;
  effort: EstablishedEffort | null;
  board: Board;
  onOpenThread: (threadId: string) => void;
  onCoordinated: (effortKey: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<ReadyPlan | null>(null);
  const [effortName, setEffortName] = useState("");
  const [goal, setGoal] = useState("");
  const [projectId, setProjectId] = useState("");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [threadId, setThreadId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = effort?.coordinatorState === "ready" ? effort.coordinatorThreadId : null;
  const creating = effort?.coordinatorState === "creating";
  const prLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const { repo, pr } of board.prInventory.entries) labels.set(pr.url.toLowerCase(), `${repo} #${pr.number} (${pr.title})`);
    for (const group of board.groups) for (const cluster of group.clusters) for (const unit of cluster.units) {
      if (unit.pr !== null) labels.set(unit.pr.url.toLowerCase(), `${unit.repo ?? unit.dirName} #${unit.pr.number} (${unit.pr.title})`);
    }
    return labels;
  }, [board]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setPlan(null);
    setError(null);
    setBusy(false);
    setThreadId("");
    rpc.call("effort_plan", { groupKey }).then((result) => {
      if (!live) return;
      if (!result.ok) { setError(result.error); return; }
      setPlan(result);
      setEffortName(result.name);
      setGoal(result.goal);
      setProjectId(result.effort?.projectId ?? (result.projects.length === 1 ? result.projects[0]!.id : ""));
      setMode(result.effort === null ? "new" : "existing");
    }, (cause: unknown) => {
      if (live) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { live = false; };
  }, [open, groupKey, rpc]);

  const threads = plan?.threads.filter((thread) => thread.projectId === projectId) ?? [];
  const ready = plan !== null && effortName.trim() !== "" && goal.trim() !== "" && plan.projects.some((project) => project.id === projectId) &&
    (mode === "new" ? plan.effort === null : threads.some((thread) => thread.id === threadId));
  const coordinate = async () => {
    if (!ready || plan === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("effort_coordinate", {
        groupKey, name: effortName.trim(), goal: goal.trim(), projectId, members: plan.members,
        ...(mode === "existing" ? { threadId } : {}),
      });
      if (!result.ok) { setError(result.error); setBusy(false); return; }
      onCoordinated(result.effort.key);
      setOpen(false);
      if (result.effort.coordinatorThreadId !== null) onOpenThread(result.effort.coordinatorThreadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return <>
    <button type="button" disabled={busy} onClick={() => current === null ? setOpen(true) : onOpenThread(current)}
      aria-label={`${current === null ? "Coordinate" : "Open effort thread for"} ${name}`}
      title={current === null ? "Keep the effort's goal, decisions, and next actions in one planning thread" : effort?.goal}
      className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
      <span aria-hidden="true">🧭 </span>{creating ? "Reconnect…" : current !== null ? "Effort thread" : effort === null ? "Coordinate" : "Reconnect"}
    </button>
    <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <DialogContent className={cn("max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto", POINTER_CURSORS)}>
        <DialogHeader>
          <DialogTitle>Coordinate effort</DialogTitle>
          <DialogDescription>{name}</DialogDescription>
        </DialogHeader>
        {plan === null ? error === null ? <p className="text-[12.5px] text-muted-foreground">Reading linked work and available projects…</p> : null : <>
          <p className="text-[12px] text-muted-foreground">A planning thread holds this effort's goal and next steps. PR repairs keep their own checkouts and result cards.</p>
          <label className="grid gap-1.5 text-[12.5px] font-medium">Effort name
            <input value={effortName} onChange={(event) => setEffortName(event.target.value)} readOnly={plan.effort !== null} disabled={busy} maxLength={160}
              className="h-8 w-full rounded-md border border-input bg-background px-2.5 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" />
          </label>
          <label className="grid gap-1.5 text-[12.5px] font-medium">Goal
            <textarea value={goal} onChange={(event) => setGoal(event.target.value)} readOnly={plan.effort !== null} disabled={busy} maxLength={4000} rows={3}
              className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" />
          </label>
          <details className="rounded-md border border-border px-3 py-2 text-[12px]">
            <summary className="cursor-pointer font-medium">Linked work · {plan.members.tickets.length} tickets · {plan.members.prUrls.length} PRs</summary>
            <div className="mt-2 max-h-40 space-y-2 overflow-y-auto">
              {plan.members.tickets.length > 0 ? <p className="flex flex-wrap gap-1.5">{plan.members.tickets.map((ticket) => <span key={ticket} className="rounded bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[11px]">{ticket}</span>)}</p> : null}
              {plan.members.prUrls.length > 0 ? <ul className="space-y-1">{plan.members.prUrls.map((url) => <li key={url}><UrlLink href={url} className="break-words text-muted-foreground underline underline-offset-2 hover:text-foreground">{prLabels.get(url.toLowerCase()) ?? `${url} (pull request details unavailable)`}</UrlLink></li>)}</ul> : null}
            </div>
          </details>
          <label className="grid gap-1.5 text-[12.5px] font-medium">BB project
            <select value={projectId} onChange={(event) => { setProjectId(event.target.value); setThreadId(""); }} disabled={busy || plan.effort !== null}
              className="h-8 w-full rounded-md border border-border bg-background px-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              <option value="">Choose a project</option>
              {plan.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          {plan.projects.length === 0 ? <p className="text-[12px] text-muted-foreground">No available BB project matches this effort. Add its checkout to a project, then reopen this dialog.</p> : null}
          <div role="radiogroup" aria-label="Effort thread" className="flex flex-wrap gap-1.5">
            {(["new", "existing"] as const).map((option) => <button key={option} type="button" role="radio" aria-checked={mode === option}
              disabled={busy || (option === "new" && plan.effort !== null)} onClick={() => setMode(option)}
              className={cn("rounded-md border px-2.5 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40", mode === option ? "border-foreground/60 bg-foreground/[0.07] font-medium" : "border-border")}>
              {option === "new" ? "Create effort thread" : "Use existing thread"}
            </button>)}
          </div>
          {mode === "new" ? <div className="space-y-1 text-[12px] text-muted-foreground">
            <p className="font-medium text-foreground">{effortTitle(effortName.trim() || plan.name)}</p>
            <p>Uses the selected project's default agent and a separate workspace. The first turn reviews this scope and proposes next actions.</p>
          </div> : <label className="grid gap-1.5 text-[12.5px] font-medium">Existing thread
            <select value={threadId} onChange={(event) => setThreadId(event.target.value)} disabled={busy || projectId === ""}
              className="h-8 w-full rounded-md border border-border bg-background px-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              <option value="">Choose an idle thread</option>
              {threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
            </select>
            <span className="font-normal text-[11.5px] text-muted-foreground">{projectId !== "" && threads.length === 0 ? "No eligible idle threads in this project." : `Renames this thread to “${effortTitle(effortName.trim() || plan.name)}” and links it as the coordinator. Existing PR threads keep their current parents.`}</span>
          </label>}
          {plan.effort?.coordinatorThreadId ? <button type="button" onClick={() => onOpenThread(plan.effort!.coordinatorThreadId!)} className="w-fit rounded text-[12px] text-muted-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">Open previous effort thread</button> : null}
        </>}
        {error === null ? null : <p role="alert" className="text-[12.5px] text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={!ready || busy} onClick={() => void coordinate()}>{busy ? "Connecting…" : mode === "new" ? "Create effort thread" : "Use this thread"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
