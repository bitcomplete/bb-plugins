import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button.js";
import type { rpcContract } from "./server.js";
import type { Row, View } from "./types.js";

function useInbox() {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const refresh = useCallback(() => { void rpc.call("inbox_get").then(setView, report); }, [rpc, report]);
  useEffect(refresh, [refresh]);
  useEffect(() => { const timer = setInterval(refresh, 15_000); return () => clearInterval(timer); }, [refresh]);
  useRealtime("inbox-changed", refresh);
  return { rpc, view, error, setError, report, refresh };
}

export function InboxPage() {
  const { rpc, view, error, setError, report, refresh } = useInbox();
  const navigate = useBbNavigate();
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [pending, setPending] = useState(false);
  const act = async (operation: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true); setError(null);
    try { await operation(); refresh(); }
    catch (cause) { report(cause); refresh(); }
    finally { setPending(false); }
  };
  const rows = view?.rows ?? [];
  const yours = rows.filter((row) => row.turn && !row.dismissed);
  const dismissed = rows.filter((row) => row.turn && row.dismissed);
  const other = rows.filter((row) => !row.turn);
  const eligible = yours.filter((row) => row.dispatch.kind === "none");
  const chosen = eligible.filter((row) => selected.get(row.id) === row.activity);
  const address = (items: Row[]) => act(async () => {
    const result = await rpc.call("address", { items: items.map(({ id, activity }) => ({ id, activity })) });
    setSelected(new Map()); navigate.toThread(result.threadId);
  });
  const section = (label: string, items: Row[], kind: "turn" | "dismissed" | "other") => (
    <section className="mt-6" aria-label={label}>
      <div className="mb-2 flex items-center gap-3">
        {kind === "turn" && eligible.length > 0 ? <input type="checkbox" aria-label="Select all actionable PRs"
          checked={chosen.length === eligible.length} onChange={(event) => setSelected(event.target.checked ? new Map(eligible.map((row) => [row.id, row.activity])) : new Map())} /> : null}
        <h2 className="text-sm font-semibold">{label} <span className="text-muted-foreground">{items.length}</span></h2>
      </div>
      {items.length === 0 ? <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">Nothing waits on you.</p> :
        <ul className="divide-y divide-border rounded-lg border border-border bg-card px-4">
          {items.map((row) => <li key={row.id} className="flex flex-wrap items-center gap-3 py-3">
            {kind === "turn" && row.dispatch.kind === "none" ? <input type="checkbox" aria-label={`Select ${row.repo}#${row.number}`}
              checked={selected.get(row.id) === row.activity} onChange={(event) => setSelected((current) => {
                const next = new Map(current); if (event.target.checked) next.set(row.id, row.activity); else next.delete(row.id); return next;
              })} /> : null}
            <div className="min-w-0 flex-1">
              <a className="block truncate text-sm font-medium hover:underline" href={row.url} target="_blank" rel="noreferrer">{row.title}</a>
              <p className="mt-1 text-xs text-muted-foreground">{row.repo}#{row.number}{row.draft ? " · Draft" : ""}</p>
              <p className="mt-1 text-xs text-muted-foreground">{row.turn?.why ?? "Waiting on reviewers or checks"}</p>
              {row.dispatch.kind === "uncertain" ? <p role="alert" className="mt-1 text-xs text-destructive">{row.dispatch.detail}</p> : null}
            </div>
            {row.dispatch.kind === "linked" ? <Button variant="outline" size="sm" onClick={() => {
              if (row.dispatch.kind === "linked") navigate.toThread(row.dispatch.threadId);
            }}>Thread · {row.threadStatus}</Button> : row.dispatch.kind === "starting" ? <span className="text-xs text-muted-foreground">Starting…</span> :
              kind === "turn" && row.dispatch.kind === "none" ? <Button size="sm" disabled={pending || !view?.project} onClick={() => void address([row])}>Address comments</Button> : null}
            {row.dispatch.kind === "uncertain" || (row.dispatch.kind === "linked" && ["idle", "error"].includes(row.threadStatus ?? "")) ?
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => rpc.call("clear_dispatch", { id: row.id }))}>Clear attempt</Button> : null}
            {kind !== "other" ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => rpc.call("dismiss", { id: row.id, activity: row.activity, dismissed: kind !== "dismissed" }))}>
              {kind === "dismissed" ? "Restore" : "Dismiss"}</Button> : null}
          </li>)}
        </ul>}
    </section>
  );
  return <div className="h-full min-h-0 flex-1 overflow-y-auto">
    <main className="mx-auto w-full max-w-4xl p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-lg font-semibold">Your turn</h1><p className="mt-1 text-sm text-muted-foreground">Human feedback waiting on your pull requests.</p></div>
        <Button variant="outline" disabled={pending} onClick={() => void act(() => rpc.call("poll_now"))}>{pending ? "Working…" : "Refresh"}</Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{view?.poll?.lastSuccess ? `@${view.poll.login} · Last refreshed ${new Date(view.poll.lastSuccess).toLocaleString()}` : "Waiting for the first GitHub refresh…"}</p>
      {error || view?.poll?.error ? <p role="alert" className="mt-3 rounded-md border border-destructive p-3 text-sm text-destructive">{error ?? view?.poll?.error}</p> : null}
      {view && !view.project ? <p className="mt-3 text-sm text-muted-foreground">Choose a project in PR Feedback settings to enable Address comments.</p> : null}
      {view === null ? <p role="status" className="mt-6 text-sm text-muted-foreground">Loading pull requests…</p> : <>
        {chosen.length > 0 ? <div className="mt-5 flex items-center gap-3"><Button disabled={pending || !view.project || chosen.length > 20} onClick={() => void address(chosen)}>Address {chosen.length} selected</Button><span className="text-xs text-muted-foreground">One thread · up to 20 PRs</span></div> : null}
        {section("Your turn", yours, "turn")}
        {dismissed.length > 0 ? <details className="mt-5"><summary className="cursor-pointer text-sm text-muted-foreground">{dismissed.length} dismissed · show</summary>{section("Dismissed", dismissed, "dismissed")}</details> : null}
        {other.length > 0 ? <details className="mt-5"><summary className="cursor-pointer text-sm text-muted-foreground">Other open PRs · {other.length}</summary>{section("Other open PRs", other, "other")}</details> : null}
      </>}
      <p className="mt-5 text-xs text-muted-foreground">Dismiss until new commits or human feedback. Address starts a thread to fix and reply to comments; it never merges.</p>
    </main>
  </div>;
}

function InboxCount() {
  const { view } = useInbox();
  return <span className="text-xs text-muted-foreground">{view?.rows.filter((row) => row.turn && !row.dismissed).length ?? 0}</span>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "inbox", title: "PR Feedback", icon: "Inbox", path: "inbox", component: InboxPage, headerContent: InboxCount });
});
