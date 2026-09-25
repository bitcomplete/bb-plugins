import { useEffect, useMemo, useState } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { Board, rpcContract } from "./server";
import type { Row } from "./inbox";
import { BACKLOG_GROUPS, BACKLOG_LABEL, backlogMatches, prBacklog, type BacklogRow } from "./pr-backlog";
import { RowActionMenu, type ActionRequest } from "./rowactions";
import { ThreadMenu } from "./threadmenu";
import { ArchivedThreadsButton } from "./archivedthreads";
import { ageHint, rowAge, shortAge, shortVerb } from "./rowlabels";
import { relativeTime } from "./workstreams";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { isApprovedOpenPr, matchesApprovedFilter } from "./approval-filter";
import type { AdvanceJob } from "./bulk-advance";
import { advanceStatus, advanceResultForPr } from "./bulk-advance-results";
import { AdvancePreviewButton } from "./bulk-advance-view";
import { ADVANCE_SELECTION_LIMIT, advancePrKey, eligibleAdvanceSelection, reconcileAdvanceSelection, selectVisibleApproved, type AdvanceSelection } from "./bulk-advance-selection";

export function PrBacklog({ board, locals, now, width, onRequest, onMessage, onCheckout, onStart, onOpenThread, threadsOf, unassignedQuery, embeddedEffortKey, checkoutFiltersActive = false, approvedOnly = false, onClearApproved, advanceActive = false, advanceJobs = [], onAdvanceStarted }: {
  board: Board; locals: Row[]; now: number; width: number;
  /** Embed inventory-only PRs under Efforts without adding another set of controls. */
  unassignedQuery?: string;
  /** When set, render only server-associated siblings under this effort heading. */
  embeddedEffortKey?: string;
  checkoutFiltersActive?: boolean;
  approvedOnly?: boolean;
  onClearApproved: () => void;
  advanceActive?: boolean;
  advanceJobs?: AdvanceJob[];
  onAdvanceStarted?: () => void;
  onRequest: (request: ActionRequest) => void; onMessage: (row: Row) => void;
  onCheckout: (row: Row) => void; onStart: (row: Row) => void;
  onOpenThread: (id: string) => void; threadsOf: (row: Row) => Row["cluster"]["threads"];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const inventory = board.prInventory;
  const [query, setQuery] = useState("");
  const [refreshPending, setRefreshPending] = useState(false);
  const [selection, setSelection] = useState<AdvanceSelection>({ urls: [], removed: 0 });
  const selectedUrls = selection.urls;
  const setSelectedUrls = (urls: string[]) => setSelection({ urls, removed: 0 });
  const rows = useMemo(() => prBacklog(inventory.entries, locals, now), [inventory.entries, locals, now]);
  useEffect(() => { setSelection((current) => reconcileAdvanceSelection(current, rows.map((row) => row.pr))); }, [rows]);
  const embedded = unassignedQuery !== undefined;
  const shown = rows.filter((row) => (!embedded || (row.local === null && row.effortKey === embeddedEffortKey)) && matchesApprovedFilter(row.pr, approvedOnly) && backlogMatches(row, unassignedQuery ?? query));
  const selected = eligibleAdvanceSelection(selectedUrls, rows.map((row) => row.pr));
  const selectedSet = new Set(selected);
  const visibleApproved = shown.filter((row) => isApprovedOpenPr(row.pr));
  const removed = selection.removed + selectedUrls.length - selected.length;
  const hiddenSelected = selected.filter((url) => !shown.some((row) => advancePrKey(row.pr.url) === url)).length;
  const approved = rows.filter((row) => row.pr.reviewDecision === "APPROVED").length;
  const ready = rows.filter((row) => row.group === "ready").length;
  const compact = width < 1060;
  const tight = width < 560;
  const refresh = async () => {
    setRefreshPending(true);
    try { await rpc.call("inventory_refresh"); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : "PR refresh failed"); }
    finally { setRefreshPending(false); }
  };
  const act = (row: BacklogRow) => {
    if (row.action === null) return;
    if (row.action.kind === "jump") {
      const behind = row.action.behind;
      const parent = rows.find((item) => item.repo === row.repo && item.pr.number === behind);
      if (parent !== undefined) {
        setQuery("");
        if (!matchesApprovedFilter(parent.pr, approvedOnly)) onClearApproved();
        requestAnimationFrame(() => {
          const target = document.getElementById(`backlog-${parent.pr.url}`) ?? (parent.local === null ? null : document.getElementById(`inbox-${parent.local.key}`));
          if (target !== null) target.scrollIntoView({ block: "center", behavior: "smooth" });
          else toast.info(`Parent PR is in ${parent.local?.effort ?? "the PR backlog"}. Open PR backlog to see its next action.`);
        });
      } else toast.info("The parent PR is outside this authored backlog. Open the PR to follow its base branch.");
    } else if (row.action.kind === "agent") {
      if (row.local !== null) onRequest({ kind: "agent", action: row.action.action, row: row.local });
    } else onRequest({ kind: "direct", action: row.action.action, row: row.local ?? {
      repo: row.repo, title: row.pr.title, age: rowAge(row.pr, null), unit: { pr: row.pr, prUrl: row.pr.url },
    } });
  };
  if (embeddedEffortKey !== undefined && shown.length === 0) return null;
  if (embedded && shown.length === 0 && inventory.complete && inventory.warnings.length === 0 && !inventory.refreshing) return null;
  return (
    <>
      {embedded ? null : <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2">
        <input aria-label="Search PR backlog" placeholder="Search repo, PR #, title, or effort…" value={query} onChange={(event) => setQuery(event.target.value)} className={cn("h-8 min-w-40 flex-1 rounded-md border border-input bg-background px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring", tight && "basis-full")} />
        <Button variant="ghost" size="sm" disabled={inventory.refreshing || refreshPending} onClick={() => void refresh()}>{inventory.refreshing || refreshPending ? "Refreshing…" : "Refresh PRs"}</Button>
        <ArchivedThreadsButton />
      </div>}
      {embedded ? null : <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 px-4 py-2 text-[11.5px]">
        <button type="button" disabled={advanceActive || visibleApproved.length === 0 || selected.length >= ADVANCE_SELECTION_LIMIT} onClick={() => setSelectedUrls(selectVisibleApproved(selected, shown.map((row) => row.pr)))} className="rounded text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">Select visible approved · {visibleApproved.length}</button>
        <span className="text-muted-foreground">{selected.length} selected{hiddenSelected > 0 ? ` · ${hiddenSelected} hidden by search` : ""}</span>
        {selectedUrls.length > 0 || removed > 0 ? <button type="button" onClick={() => setSelectedUrls([])} className="rounded text-muted-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">Clear</button> : null}
        <span className="flex-1" />
        <AdvancePreviewButton prUrls={selected} disabled={advanceActive} onStarted={() => { setSelectedUrls([]); onAdvanceStarted?.(); }} />
        {advanceActive ? <p className="basis-full text-muted-foreground">An advance batch is active or awaiting reconciliation. Follow its progress above.</p> : null}
        {removed > 0 ? <p role="status" className="basis-full text-amber-700 dark:text-amber-300">{removed} {removed === 1 ? "selection removed" : "selections removed"}: these PRs closed, lost approval, or are no longer in the backlog.</p> : null}
        {selected.length >= ADVANCE_SELECTION_LIMIT ? <p role="status" className="basis-full text-muted-foreground">Up to {ADVANCE_SELECTION_LIMIT} PRs per batch. Advance this selection before selecting more.</p> : null}
      </div>}
      <div className={embedded ? undefined : "min-h-0 flex-1 overflow-y-auto"}>
        <div className={embedded ? undefined : "mx-auto w-full max-w-6xl px-4 pb-10"}>
          {embedded ? null : <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-2 pt-3 text-[11.5px] text-muted-foreground">
            <span className="text-foreground">{rows.length} open · {approved} approved · {ready} ready to merge</span>
            <span>{inventory.lastSuccessAt === null ? "Awaiting first complete refresh" : `Checked ${relativeTime(inventory.lastSuccessAt, now)}`}{inventory.refreshing ? " · refreshing" : ""}</span>
            {shown.length !== rows.length ? <span>{shown.length} shown</span> : null}
          </div>
          <p className="px-2 pt-1 text-[11px] text-muted-foreground">Your PRs in {inventory.owners.length === 0 ? "organizations represented by scanned projects" : inventory.owners.join(", ")}.</p>

          {shown.length === 0 ? <p className="px-2 py-5 text-[12px] text-muted-foreground">{inventory.refreshing ? "Reading your open PRs from GitHub…" : rows.length === 0 ? "No open PRs found in this scope." : "No matching PRs."}</p> : null}
          </>}
          {embeddedEffortKey === undefined && (!inventory.complete || inventory.warnings.length > 0) ? (
            <details className="mx-2 mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11.5px] text-muted-foreground">
              <summary className="cursor-pointer text-amber-700 dark:text-amber-300">{inventory.lastAttemptAt === null ? "Inventory has not been refreshed yet" : "Coverage is partial; some PRs may be missing or stale"}</summary>
              <ul className="mt-1 list-disc space-y-1 pl-4">{inventory.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
            </details>
          ) : null}
          {embedded && embeddedEffortKey === undefined && inventory.refreshing && shown.length === 0 ? <p className="px-2 pt-3 text-[11.5px] text-muted-foreground">Reading PR backlog from GitHub…</p> : null}
          {(embedded ? ["unassigned" as const] : BACKLOG_GROUPS).map((group) => {
            const items = group === "unassigned" ? shown : shown.filter((row) => row.group === group);
            if (items.length === 0) return null;
            const label = group === "unassigned" ? "No effort assigned" : BACKLOG_LABEL[group];
            return <section key={group} aria-label={embeddedEffortKey === undefined ? label : "Related PRs without checkouts"} className={embeddedEffortKey === undefined ? "pt-5" : undefined}>
              {embeddedEffortKey === undefined ? <h2 className="flex items-baseline gap-2 px-2 pb-1.5 text-[13px] font-semibold">{label}<span className="font-mono text-[11px] font-normal text-muted-foreground">{items.length}</span></h2> : null}
              {embeddedEffortKey === undefined ? null : <p className="mx-2 mt-2 border-t border-border/40 pb-1 pt-2 text-[10.5px] text-muted-foreground">Related PRs without checkouts</p>}
              {embedded && (embeddedEffortKey === undefined || checkoutFiltersActive) ? <p className="px-2 pb-2 text-[11px] text-muted-foreground">{embeddedEffortKey === undefined ? "Your open PRs without a scanned checkout. Merge, update, or nudge here; agent fixes need a checkout." : "Related PRs have no scanned checkout."}{checkoutFiltersActive ? " Checkout date and surface filters do not apply to these PRs; search still does." : ""}</p> : null}
              <ul>{items.map((row) => {
                const advanceResult = advanceResultForPr(advanceJobs, row.pr, row.group === "ready");
                const age = rowAge(row.pr, null);
                const threads = row.local === null ? [] : threadsOf(row.local);
                const needsCheckout = row.action?.kind === "agent" && row.local === null;
                const canAdvance = needsCheckout && isApprovedOpenPr(row.pr) && row.action?.kind === "agent" && ["resolve-conflicts", "address-comments", "address-review", "review-approval-note"].includes(row.action.action);
                const gate = row.stale ? row.verb : row.pr.reviewDecision === "APPROVED" && !shortVerb(row.verb).startsWith("Approved") ? `Approved · ${shortVerb(row.verb)}` : shortVerb(row.verb);
                const detail = [row.pr.title, row.local === null ? `${row.effortName === undefined ? "" : `Effort: ${row.effortName}\n`}No scanned checkout. Advance can create an isolated checkout for approved feedback or branch work; other agent fixes need a checkout.` : `Effort: ${row.local.effort}`, row.parent === null ? null : `Waiting on ${row.parent.repo} #${row.parent.pr.number} (${row.parent.pr.title})`, row.pr.resolvedReviewThreads ? `${row.pr.resolvedReviewThreads} review threads resolved` : null].filter(Boolean).join("\n");
                return <li key={row.pr.url} data-pr-backlog-row id={`backlog-${row.pr.url}`} className={cn("grid min-w-0 items-center gap-x-3 gap-y-1 rounded-md border-b border-border/40 px-2 py-2 text-[12px] hover:bg-foreground/[0.035]", compact ? tight ? "grid-cols-[minmax(0,1fr)_3rem_6.5rem]" : "grid-cols-[minmax(9rem,1fr)_minmax(10rem,1fr)_3rem_6.5rem]" : "grid-cols-[11rem_minmax(0,1fr)_12rem_3rem_8rem_3rem]")}>
                  <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
                    {!embedded ? <input type="checkbox" aria-label={`Select ${row.repo} #${row.pr.number} (${row.pr.title}) for advance`} checked={selectedSet.has(advancePrKey(row.pr.url))} disabled={advanceActive || !isApprovedOpenPr(row.pr) || (!selectedSet.has(advancePrKey(row.pr.url)) && selected.length >= ADVANCE_SELECTION_LIMIT)} onChange={(event) => setSelectedUrls(event.target.checked ? [...selected, advancePrKey(row.pr.url)] : selected.filter((url) => url !== advancePrKey(row.pr.url)))} className="size-3.5 shrink-0 accent-current disabled:opacity-25" title={isApprovedOpenPr(row.pr) ? "Select to address feedback, prepare the branch, and verify readiness" : "Advance starts with approved, open PRs"} /> : null}
                    <UrlLink href={row.pr.url} title={detail} className="flex min-w-0 items-baseline gap-1.5 text-foreground underline-offset-2 hover:underline"><span className="truncate font-semibold">{row.repo.split("/").at(-1)}</span><span className="shrink-0 font-mono text-[11.5px]">#{row.pr.number}</span></UrlLink>
                  </span>
                  <Tip label={detail}><span tabIndex={0} className={cn("min-w-0 truncate text-foreground/80 outline-none focus-visible:ring-2 focus-visible:ring-ring", compact ? tight ? "col-span-2 col-start-1 row-start-2" : "col-span-3 col-start-1 row-start-2" : "col-start-2 row-start-1")}>{row.pr.title}</span></Tip>
                  <Tip label={detail}><span tabIndex={0} className={cn("min-w-0 truncate text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring", row.group === "ready" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground", compact ? tight ? "col-span-3 col-start-1 row-start-3" : "col-start-2 row-start-1" : "col-start-3 row-start-1")}>{gate}{row.stale ? " · stale" : ""}</span></Tip>
                  <Tip label={ageHint(age, now)}><span className={cn("text-right font-mono text-[10.5px] text-muted-foreground", compact ? tight ? "col-start-2 row-start-1" : "col-start-3 row-start-1" : "col-start-4 row-start-1")}>{shortAge(age, now)}</span></Tip>
                  <span className={cn("flex min-w-0 justify-end", compact ? tight ? "col-start-3 row-start-2" : "col-start-4 row-start-2" : "col-start-5 row-start-1")}>
                    {needsCheckout ? <Tip label={canAdvance ? "Select this PR in the backlog and use Advance selected to address feedback and prepare its branch in an isolated checkout." : "A scanned checkout is needed for this agent fix. Advance does not repair unrelated CI failures."}><span className="flex min-w-0 flex-col items-end text-[10px] text-muted-foreground"><span>{canAdvance ? embedded ? "Use PR backlog" : "Select to advance" : "Checkout needed"}</span><UrlLink href={row.pr.url} className="text-[11px] underline underline-offset-2">Open PR ↗</UrlLink></span></Tip> : row.action !== null ? <button type="button" onClick={() => act(row)} className="max-w-full truncate rounded border border-border px-2 py-1 text-[11px] outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring">{row.action.label}</button> : null}
                  </span>
                  <span className={cn("flex items-center justify-end", compact ? tight ? "col-start-3 row-start-1" : "col-start-4 row-start-1" : "col-start-6 row-start-1")}>
                    {row.local === null ? <Tip label={canAdvance ? "Advance can create an isolated checkout for this work" : needsCheckout ? "Checkout needed for this agent fix" : "No scanned checkout; GitHub actions remain available"}><span className="text-[10px] text-muted-foreground">GitHub</span></Tip> : <>
                      {threads.length > 0 ? <ThreadMenu threads={threads} onOpenThread={onOpenThread} onMore={() => onOpenThread(threads[0]!.id)} className="flex size-6 items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className={cn("size-1.5 rounded-full", threads.some((thread) => thread.active) ? "bg-sky-400" : "bg-muted-foreground/50")} /></ThreadMenu> : null}
                      <RowActionMenu hasThreads={threads.length > 0} hasOpenPr onGoToThread={() => threads[0] && onOpenThread(threads[0].id)} onMessageAgent={() => onMessage(row.local!)} onOpenCheckout={() => onCheckout(row.local!)} onNewThread={() => onStart(row.local!)} />
                    </>}
                  </span>
                  {advanceResult === null ? null : <div className="col-span-full flex min-w-0 items-center gap-2 text-[10.5px]" title={`${advanceResult.detail}${advanceResult.checkedHeadOid ? ` · Verified commit ${advanceResult.checkedHeadOid}` : ""} · ${new Date(advanceResult.updatedAt).toLocaleString()}`}>
                    <span className={cn("shrink-0 font-medium", advanceResult.status === "ready" ? "text-emerald-700 dark:text-emerald-400" : advanceResult.status === "needs-attention" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>Advance · {advanceStatus(advanceResult)}</span>
                    <span className="min-w-0 truncate text-muted-foreground">{advanceResult.detail}</span>
                    {advanceResult.threadId ? <button type="button" onClick={() => onOpenThread(advanceResult.threadId!)} className="ml-auto shrink-0 rounded text-muted-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">Worker ↗</button> : null}
                  </div>}
                </li>;
              })}</ul>
            </section>;
          })}
        </div>
      </div>
    </>
  );
}
