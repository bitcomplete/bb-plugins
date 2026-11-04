import { useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { threadWorking } from "./pr-status.js";
import type { CloseResult, Row } from "./types.js";

type Phase =
  | { kind: "confirm" }
  | { kind: "closing" }
  | { kind: "results"; results: CloseResult[] }
  | { kind: "error"; message: string };

const pullRequests = (count: number) => `${count} pull request${count === 1 ? "" : "s"}`;

function summary(phase: Phase, count: number): string {
  switch (phase.kind) {
    case "confirm": return "GitHub closes each PR without merging it. Each branch stays, and you can reopen a PR on GitHub.";
    case "closing": return `Closing ${pullRequests(count)}…`;
    case "error": return "My PRs did not receive a result for this close request.";
    case "results": {
      const closed = phase.results.filter((result) => result.kind === "closed").length;
      return closed === count ? `Closed ${pullRequests(count)}.`
        : `GitHub confirmed ${closed} of ${count} closes. Unconfirmed PRs that remain listed stay selected. Refresh GitHub before you retry.`;
    }
    default: { const exhaustive: never = phase; return exhaustive; }
  }
}

export function ClosePrsDialog({ items, onDismiss, onConfirm, onRefreshGithub }: {
  items: readonly Row[];
  onDismiss: () => void;
  onConfirm: () => Promise<CloseResult[]>;
  onRefreshGithub: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const submitted = useRef(false);
  const closing = phase.kind === "closing";
  const results = new Map(phase.kind === "results" ? phase.results.map((result) => [result.id, result]) : []);
  const working = items.filter(threadWorking).length;
  const needsRefresh = phase.kind === "error" || (phase.kind === "results" && phase.results.some((result) => result.kind === "failed"));

  const confirm = async () => {
    if (submitted.current) return;
    submitted.current = true;
    setPhase({ kind: "closing" });
    try { setPhase({ kind: "results", results: await onConfirm() }); }
    catch (cause) { setPhase({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) }); }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !closing) onDismiss(); }}>
      <DialogContent hideCloseButton={closing} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{phase.kind === "results" ? "Close results" : phase.kind === "error" ? "Close request failed" : `Close ${pullRequests(items.length)}?`}</DialogTitle>
          <DialogDescription role="status">{summary(phase, items.length)}</DialogDescription>
        </DialogHeader>
        <ul aria-label="Selected pull requests" tabIndex={0}
          className="grid max-h-64 list-none gap-2 overflow-y-auto rounded-md border border-border p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {items.map((row) => {
            const result = results.get(row.id);
            return <li key={row.id} className="min-w-0 break-words">
              <span className="font-medium">{row.repo}#{row.number}</span>{" "}
              <span className="text-muted-foreground">{row.title}</span>
              {threadWorking(row) ? <span className="block text-xs text-muted-foreground">Thread working</span> : null}
              {result?.kind === "closed" ? <span className="block text-xs font-medium">Closed</span> : null}
              {result?.kind === "failed" ? <span className="block text-xs text-destructive">{result.message}</span> : null}
            </li>;
          })}
        </ul>
        {working > 0 ? <p className="text-xs text-muted-foreground">
          {working === 1 ? "1 selected PR has a working thread" : `${working} selected PRs have working threads`}. Closing a PR does not stop its thread.
        </p> : null}
        {phase.kind === "error" ? <div role="alert" className="text-sm text-destructive">
          <p>{phase.message}</p>
          <p>Some PRs might have closed. Refresh GitHub before you try again.</p>
        </div> : null}
        <DialogFooter>
          {phase.kind === "results" || phase.kind === "error" ? <>
            {needsRefresh ? <Button variant="outline" onClick={() => { onRefreshGithub(); onDismiss(); }}>Refresh GitHub</Button> : null}
            <Button key="done" autoFocus onClick={onDismiss}>Done</Button>
          </> : <>
            <Button autoFocus variant="outline" disabled={closing} onClick={onDismiss}>Cancel</Button>
            <Button variant="destructive" disabled={closing} aria-busy={closing || undefined} onClick={confirm}>
              {closing ? "Closing…" : `Close ${items.length} PR${items.length === 1 ? "" : "s"}`}
            </Button>
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
