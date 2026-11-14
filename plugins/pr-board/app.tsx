// PR board frontend: draws the view model the backend stores. Wording, grouping and suggestions come
// from simple.py; this file holds the panel's own state (open sections, filter, confirmation) only.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { definePluginApp, experimental_usePluginId, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Action, BoardState, MarkerView, Stop } from "./board";
import { Confirm, MUTED, PrRow, ReviewerLoad, Trains, type Row, type Section } from "./board-ui";
import { summaryParts } from "./format";
import type { rpcContract } from "./server";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

function useBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<BoardState | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const settle = useCallback((promise: Promise<BoardState>) => {
    promise.then(
      (next) => {
        setState(next);
        setCallError(null);
      },
      (cause: unknown) => setCallError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, []);
  const refetch = useCallback(() => settle(rpc.call("board_get")), [rpc, settle]);
  const refresh = useCallback(() => {
    setState((current) => (current ? { ...current, refreshing: true } : current));
    settle(rpc.call("board_refresh"));
  }, [rpc, settle]);
  const start = useCallback(
    async (keys: string[], action: Action, stop: Stop) => {
      try {
        const { skipped } = await rpc.call("start", { items: keys.map((key) => ({ key, action })), stop });
        for (const s of skipped) toast(`#${s.key.split("#")[1]} not started: ${s.reason}`);
      } catch (cause) {
        toast.error(`Could not start: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      refetch();
    },
    [rpc, refetch],
  );
  useEffect(refetch, [refetch]);
  useRealtime("board-changed", refetch);
  return { state, error: callError ?? state?.lastError ?? null, refresh, start };
}

/** Open/closed per section id, kept for this browser session. */
function useOpenSections() {
  const key = `${experimental_usePluginId()}:open-sections`;
  const [saved, setSaved] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const setOpen = useCallback(
    (id: string, open: boolean) =>
      setSaved((current) => {
        const next = { ...current, [id]: open };
        sessionStorage.setItem(key, JSON.stringify(next));
        return next;
      }),
    [key],
  );
  return { isOpen: (id: string, fallback: boolean) => saved[id] ?? fallback, setOpen };
}

function Collapsible({ title, count, open, onToggle, size = "section", children }: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  size?: "section" | "minor";
  children: ReactNode;
}) {
  return (
    <details
      open={open}
      // The browser also fires toggle when React sets `open`; record only real user changes.
      onToggle={(event) => event.currentTarget.open !== open && onToggle(event.currentTarget.open)}
      className="border-t border-border py-2.5"
    >
      <summary className="flex cursor-pointer list-none items-baseline gap-2 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className={cn("w-3 text-[11px]", MUTED)}>{open ? "▾" : "▸"}</span>
        <h2 className={size === "section" ? "text-base font-semibold" : "text-sm font-semibold"}>{title}</h2>
        {count !== undefined ? <span className={MUTED}>{count}</span> : null}
      </summary>
      {children}
    </details>
  );
}

type Filter = { kind: "stack" | "reviewer"; id: string; label: string; keys: Set<string> };
type Confirming = { id: string; action: Action; keys: string[] };

export function Board() {
  const { state, error, refresh, start } = useBoard();
  const { isOpen, setOpen } = useOpenSections();
  const [filter, setFilter] = useState<Filter | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  // Narrow panels collapse the stacks strip by default so the list stays near the top.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setNarrow(root.offsetWidth > 0 && root.offsetWidth < 440);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const view = state?.view ?? null;
  const markers = useMemo(() => new Map((state?.markers ?? []).map((m): [string, MarkerView] => [m.key, m])), [state?.markers]);
  const rows = useMemo(
    () => new Map((view?.sections ?? []).flatMap((s) => s.groups.flatMap((g) => g.rows)).map((r): [string, Row] => [r.key, r])),
    [view],
  );
  const toggleFilter = (next: Filter) => setFilter((current) => (current?.id === next.id ? null : next));

  const confirmFor = (id: string, action: Action, keys: string[]) => (
    <Confirm
      key={id}
      action={action}
      rows={keys.flatMap((key) => {
        const row = rows.get(key);
        return row ? [{ key, number: row.number, title: row.title }] : [];
      })}
      onCancel={() => setConfirming(null)}
      onStart={(chosen, stop) => {
        setConfirming(null);
        void start(chosen, action, stop);
      }}
    />
  );

  const shownSections = (view?.sections ?? []).flatMap((section): Section[] => {
    if (!filter) return [section];
    const groups = section.groups
      .map((g) => ({ ...g, rows: g.rows.filter((r) => filter.keys.has(r.key)) }))
      .filter((g) => g.rows.length > 0);
    const count = groups.reduce((n, g) => n + g.rows.length, 0);
    return count ? [{ ...section, groups, count }] : [];
  });

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden">
      <div ref={rootRef} className="@container mx-auto w-full max-w-3xl p-3 text-sm leading-normal text-foreground">
        <div className={cn("mb-2 flex items-center gap-2 text-xs", MUTED)}>
          <span className="min-w-0 flex-1">
            {view ? `As of ${new Date(view.fetched_at).toLocaleString()}` : state?.refreshing ? "Loading…" : null}
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={state?.refreshing ?? true} onClick={refresh}>
            {state?.refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        {error ? <p className={cn("mb-2 text-xs", MUTED)}>Last refresh failed: {error}</p> : null}
        {view ? (
          <>
            <p className="mb-3.5 text-[15px]">
              {summaryParts(view.summary).map((part, index) => (typeof part === "number" ? <b key={index}>{part}</b> : part))}
            </p>
            {view.suggestions.length > 0 ? (
              <Collapsible title="Suggested next steps" open={isOpen("next", true)} onToggle={(o) => setOpen("next", o)} size="minor">
                <ul className="mt-1.5 space-y-1.5">
                  {view.suggestions.map((s) => {
                    const id = `s:${s.id}`;
                    return (
                      <li key={s.id} className="text-[13.5px]">
                        <div className="flex items-baseline gap-2">
                          <span aria-hidden className={MUTED}>•</span>
                          <span className="min-w-0 flex-1">{s.text}</span>
                          {s.action && s.keys.length > 0 && confirming?.id !== id ? (
                            <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs"
                              onClick={() => setConfirming({ id, action: s.action!, keys: s.keys })}>
                              Start ({Math.min(s.keys.length, 5)})
                            </Button>
                          ) : null}
                        </div>
                        {confirming?.id === id ? <div className="pl-4">{confirmFor(id, confirming.action, confirming.keys)}</div> : null}
                      </li>
                    );
                  })}
                </ul>
              </Collapsible>
            ) : null}
            {view.trains.length > 0 ? (
              <Collapsible title="Stacks" count={view.trains.length} open={isOpen("trains", !narrow)} onToggle={(o) => setOpen("trains", o)} size="minor">
                <div className="mt-1.5">
                  <Trains trains={view.trains} selected={filter?.kind === "stack" ? filter.id : null}
                    onSelect={(t) => toggleFilter({ kind: "stack", id: t.id, label: `stack ${t.name}`, keys: new Set(t.prs.map((p) => p.key)) })} />
                </div>
              </Collapsible>
            ) : null}
            {filter ? (
              <p className="mb-1 flex items-baseline gap-2 border-t border-border pt-2.5 text-[13px]">
                <span className="min-w-0 flex-1">Showing {filter.label}</span>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setFilter(null)}>Clear</Button>
              </p>
            ) : null}
            {shownSections.map((section) => (
              <Collapsible key={section.id} title={section.title} count={section.count}
                open={filter ? true : isOpen(section.id, section.open)} onToggle={(o) => filter || setOpen(section.id, o)}>
                {section.groups.map((group) => (
                  <div key={group.title ?? ""}>
                    {group.title !== null ? (
                      <h3 className={cn("mb-1 mt-3.5 text-[13px] font-semibold", MUTED)}>
                        {group.title} <span className="font-normal">{group.rows.length}</span>
                      </h3>
                    ) : null}
                    <ul>
                      {group.rows.map((row) => (
                        <PrRow
                          key={row.key}
                          row={row}
                          marker={markers.get(row.key)}
                          confirming={confirming?.id === `r:${row.key}`}
                          onStart={() => row.action && setConfirming({ id: `r:${row.key}`, action: row.action, keys: [row.key] })}
                          renderConfirm={() => (confirming ? confirmFor(confirming.id, confirming.action, confirming.keys) : null)}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </Collapsible>
            ))}
            {view.reviewer_load.reviewers.length > 0 || view.reviewer_load.none.count > 0 ? (
              <Collapsible title="Reviewer load" open={isOpen("reviewer-load", false)} onToggle={(o) => setOpen("reviewer-load", o)} size="minor">
                <ReviewerLoad load={view.reviewer_load} selected={filter?.kind === "reviewer" ? filter.id : null}
                  onSelect={(name, keys) =>
                    toggleFilter({ kind: "reviewer", id: name, label: name === "No reviewer" ? "PRs with no reviewer requested" : `PRs waiting on ${name}`, keys: new Set(keys) })} />
              </Collapsible>
            ) : null}
          </>
        ) : state && !state.refreshing ? (
          <p className={MUTED}>No board yet.</p>
        ) : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "pr-board", title: "PR board", icon: "GitPullRequest", path: "pr-board", component: Board });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "pr-board",
    title: "PR board",
    icon: "GitPullRequest",
    layout: "flush",
    component: Board,
  });
});
