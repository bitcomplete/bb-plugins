import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, UrlLink, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { AddressProjectDialog } from "./address-project-dialog.js";
import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import { groupByOrganization } from "./areas.js";
import { cn } from "./lib/utils.js";
import type { rpcContract } from "./server.js";
import type { Row, View } from "./types.js";

const RING = "outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
const CHIP = "inline-flex h-5 min-w-0 max-w-72 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]";
const AMBER = "bg-amber-500/10 text-[light-dark(var(--color-amber-800),var(--color-amber-200))]";
const GRAY = "bg-foreground/[0.05] text-muted-foreground";
const BUTTON = cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[12px] disabled:opacity-45", RING);
const GHOST = cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING);
const COLUMN = "mx-auto w-full max-w-3xl";
const GROUP_CARD = "min-w-0 rounded-[10px] border border-border/50 bg-foreground/[0.015] px-2 py-1";
const CHECKBOX = "size-3.5 shrink-0 accent-sky-600 disabled:opacity-20";
const EMPTY = "py-8 text-center text-[12px] text-muted-foreground";
const POINTER_CURSORS = "[&_button:not(:disabled)]:cursor-pointer [&_summary]:cursor-pointer [&_a[href]]:cursor-pointer [&_input[type=checkbox]:not(:disabled)]:cursor-pointer";
type SectionKind = "turn" | "dismissed" | "other" | "held";

function age(at: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - at) / 1_000));
  return seconds < 60 ? `${seconds}s` : seconds < 3_600 ? `${Math.floor(seconds / 60)}m` : seconds < 86_400 ? `${Math.floor(seconds / 3_600)}h` : `${Math.floor(seconds / 86_400)}d`;
}

function Spin() {
  return <span aria-hidden className="inline-block leading-none motion-safe:animate-spin">↻</span>;
}

function Kbd({ children, inverted = false }: { children: string; inverted?: boolean }) {
  return <kbd className={cn("inline-block min-w-4 rounded border px-1 text-center font-mono text-[10.5px] leading-[14px]", inverted ? "border-transparent bg-background/20 text-background" : "border-border text-muted-foreground")}>{children}</kbd>;
}

function ScopeCheckbox({ items, selected, label, disabled, onPick }: {
  items: readonly Row[]; selected: ReadonlyMap<string, string>; label: string; disabled: boolean;
  onPick: (items: readonly Row[], select: boolean) => void;
}) {
  if (items.length === 0) return <span aria-hidden className="size-3.5 shrink-0" />;
  const count = items.filter((row) => selected.get(row.id) === row.activity).length;
  const full = count === items.length;
  return <input type="checkbox" checked={full} disabled={disabled} aria-label={label}
    ref={(element) => { if (element) element.indeterminate = count > 0 && !full; }}
    onChange={() => onPick(items, !full)} className={CHECKBOX} />;
}

function FeedbackRow({ row, kind, now, pending, selected, onPick, onAddress, onDismiss, onClear, onHold }: {
  row: Row; kind: SectionKind; now: number; pending: boolean; selected: boolean;
  onPick: (shift: boolean) => void; onAddress: () => void; onDismiss: () => void; onClear: () => void; onHold: (until: string | null) => void;
}) {
  const navigate = useBbNavigate();
  const threadId = row.dispatch.kind === "linked" ? row.dispatch.threadId : null;
  const clearable = row.dispatch.kind === "uncertain" || (row.dispatch.kind === "linked" && ["idle", "error"].includes(row.threadStatus ?? ""));
  const holdLabel = row.holdUntil ? `On hold until ${new Date(row.holdUntil).toLocaleString()}` : null;
  const why = row.turn?.why ?? "Waiting on reviewers or checks";
  const updated = `${age(Date.parse(row.updatedAt), now)} ago`;
  return <li className={cn("group min-w-0 rounded-md hover:bg-foreground/[0.03]", selected && "bg-sky-500/[0.07]")}>
    <div className="flex items-start gap-2 py-1 pl-2 pr-1.5 text-[12.5px] leading-5">
      {kind === "turn" && row.dispatch.kind === "none" ? <input type="checkbox" checked={selected} disabled={pending}
        aria-label={`Select ${row.repo}#${row.number}`} onChange={() => undefined} onClick={(event) => onPick(event.shiftKey)}
        className={cn(CHECKBOX, "mt-[3px] opacity-50 group-hover:opacity-100 group-focus-within:opacity-100")} /> : <span aria-hidden className="size-3.5 shrink-0" />}
      <UrlLink href={row.url} title={`${row.repo} #${row.number}`}
        className={cn("flex w-[124px] shrink-0 justify-start gap-1 whitespace-nowrap rounded-sm text-muted-foreground hover:underline @min-[720px]:w-[156px]", RING)}>
        <span className="min-w-0 truncate">{row.repo.split("/").pop()}</span>
        <b className={cn("shrink-0 font-medium", kind === "turn" ? "text-foreground" : "text-foreground/80")}>#{row.number}</b>
      </UrlLink>
      <div className="min-w-0 flex-1">
        <p className={cn("truncate", kind !== "turn" && "text-foreground/80")} title={row.title}>{row.title}</p>
        <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
          <span className="min-w-0" title={holdLabel ?? `${why} · ${updated}`}>{holdLabel ?? `${why} · ${updated}`}</span>
          <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            <span className={cn(CHIP, kind === "turn" ? AMBER : GRAY)}>{kind === "turn" ? "Your turn" : kind === "dismissed" ? "Dismissed" : kind === "held" ? "On hold" : "Waiting"}</span>
            {row.draft ? <span className={cn(CHIP, GRAY)}>Draft</span> : null}
            {threadId !== null ? <button type="button" onClick={() => navigate.toThread(threadId)}
              title={`Open its feedback thread · ${row.threadStatus ?? "unknown status"}`} className={cn(CHIP, GRAY, "hover:underline", RING)}>Open<span aria-hidden>↗</span></button> :
              row.dispatch.kind === "starting" ? <span className={cn(CHIP, GRAY)}><Spin />Starting…</span> :
                kind === "turn" && row.dispatch.kind === "none" ? <button type="button" disabled={pending}
                  aria-label={`Address comments on ${row.repo}#${row.number}`} title="Start a thread to address these comments" onClick={onAddress}
                  className={cn(BUTTON, "h-5 border-border px-1.5 text-[11px] hover:bg-foreground/[0.06]")}>Address</button> : null}
            {clearable ? <button type="button" disabled={pending} onClick={onClear} className={cn(GHOST, "h-5 px-1 text-[11px]")}>Clear attempt</button> : null}
            {kind === "held" ? <button type="button" disabled={pending} onClick={() => onHold(null)}
              aria-label={`Resume ${row.repo}#${row.number}`} className={cn(GHOST, "h-5 px-1 text-[11px]")}>Resume</button> :
              kind !== "dismissed" ? <select aria-label={`Hold ${row.repo}#${row.number}`} title="Temporarily move this PR out of your active list"
                disabled={pending} value="" onChange={(event) => {
                  const until = new Date(now);
                  if (event.target.value === "tomorrow") { until.setDate(until.getDate() + 1); until.setHours(9, 0, 0, 0); }
                  else until.setTime(now + Number(event.target.value) * 3_600_000);
                  onHold(until.toISOString());
                }} className={cn("h-5 max-w-24 rounded border-none bg-transparent px-1 text-[11px] text-muted-foreground", RING)}>
                <option value="" disabled>Hold…</option><option value="1">1 hour</option><option value="tomorrow">Tomorrow</option><option value="168">1 week</option>
              </select> : null}
            {kind === "turn" || kind === "dismissed" ? <button type="button" disabled={pending} onClick={onDismiss}
              aria-label={`${kind === "dismissed" ? "Restore" : "Dismiss"} ${row.repo}#${row.number}`}
              title={kind === "dismissed" ? "Restore this feedback" : "Dismiss until new commits or human feedback"}
              className={cn("shrink-0 rounded px-1 text-[11px] text-muted-foreground opacity-60 hover:bg-foreground/[0.06] hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100", RING)}>
              {kind === "dismissed" ? "Restore" : "Dismiss"}</button> : null}
          </span>
        </div>
        {row.dispatch.kind === "uncertain" ? <p role="alert" className="text-[11px] text-destructive">{row.dispatch.detail}</p> : null}
      </div>
    </div>
  </li>;
}

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
  const rootRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [pending, setPending] = useState(false);
  const [addressItems, setAddressItems] = useState<Row[] | null>(null);
  const [polling, setPolling] = useState(false);
  const rows = view?.rows ?? [];
  const yours = rows.filter((row) => row.turn && !row.dismissed && !row.holdUntil);
  const dismissed = rows.filter((row) => row.turn && row.dismissed && !row.holdUntil);
  const other = rows.filter((row) => !row.turn && !row.holdUntil);
  const held = rows.filter((row) => row.holdUntil);
  const organizations = groupByOrganization(yours);
  const eligible = organizations.flatMap((organization) => organization.areas.flatMap((area) => area.items.filter((row) => row.dispatch.kind === "none")));
  const chosen = eligible.filter((row) => selected.get(row.id) === row.activity);
  const now = Date.now();

  useEffect(() => {
    if (!view) return;
    const eligible = new Map(view.rows.filter((row) => row.turn && !row.dismissed && !row.holdUntil && row.dispatch.kind === "none").map((row) => [row.id, row.activity]));
    setSelected((current) => new Map([...current].filter(([id, activity]) => eligible.get(id) === activity)));
  }, [view]);

  const act = async (operation: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true); setError(null);
    try { await operation(); refresh(); }
    catch (cause) { report(cause); refresh(); }
    finally { setPending(false); }
  };
  const address = (items: Row[]) => setAddressItems(items);
  const startAddress = async (items: Row[], projectId: string) => {
    setPending(true); setError(null);
    try {
      const result = await rpc.call("address", { items: items.map(({ id, activity }) => ({ id, activity })), projectId });
      setSelected(new Map()); setAddressItems(null); refresh(); navigate.toThread(result.threadId);
    } catch (cause) { refresh(); throw cause; }
    finally { setPending(false); }
  };
  const pickScope = (items: readonly Row[], select: boolean) => setSelected((current) => {
    const next = new Map(current);
    for (const row of items) { if (select) next.set(row.id, row.activity); else next.delete(row.id); }
    return next;
  });
  const pick = (row: Row, shift: boolean) => {
    const from = eligible.findIndex((item) => item.id === anchor.current);
    const to = eligible.findIndex((item) => item.id === row.id);
    if (shift && from >= 0 && to >= 0) pickScope(eligible.slice(Math.min(from, to), Math.max(from, to) + 1), true);
    else pickScope([row], selected.get(row.id) !== row.activity);
    anchor.current = row.id;
  };
  const poll = async () => {
    if (polling) return;
    setPolling(true); setError(null);
    try { await rpc.call("poll_now"); refresh(); }
    catch (cause) { report(cause); }
    finally { setPolling(false); }
  };
  const shortcuts = useRef({ run: () => {}, clear: () => {}, count: 0, enabled: false });
  shortcuts.current = { run: () => { void address(chosen); }, clear: () => setSelected(new Map()), count: chosen.length,
    enabled: !pending && chosen.length <= 20 };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = rootRef.current;
      const active = document.activeElement;
      if (!root || (active && active !== document.body && !root.contains(active))) return;
      if (event.metaKey || event.ctrlKey || event.altKey || (event.target instanceof HTMLElement &&
        (event.target.isContentEditable || event.target.closest("input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]")))) return;
      if (shortcuts.current.count === 0) return;
      if (event.key === "Escape") { event.preventDefault(); shortcuts.current.clear(); }
      else if (event.key === "b" && !event.repeat && shortcuts.current.enabled) { event.preventDefault(); shortcuts.current.run(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const renderGroups = (items: Row[], kind: SectionKind) => <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 pb-1.5 pt-2">
    {groupByOrganization(items).map((organization) => <section key={organization.label} aria-label={`${organization.label} ${kind === "turn" ? "your turn" : kind}`} className="min-w-0">
      <h3 className="ml-[19px] flex min-w-0 items-center gap-2 pb-1 text-[12px] font-semibold">
        <span className="min-w-0 truncate">{organization.label}</span>
        <span className="text-[11px] font-normal tabular-nums text-muted-foreground">{organization.items.length}</span>
      </h3>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
        {organization.areas.map((area) => <section key={area.key} aria-label={area.label} className="min-w-0">
          <h4 className="ml-9 flex min-w-0 items-center gap-2 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">
            <span className="min-w-0 truncate">{area.label}{area.repos.join(", ") === area.label ? null : <span className="font-normal text-muted-foreground/70"> · {area.repos.join(", ")}</span>}</span>
            <span className="font-normal tabular-nums">{area.items.length}</span>
          </h4>
          <ul className={cn("ml-[19px] list-none", GROUP_CARD)}>
            {area.items.map((row) => <FeedbackRow key={row.id} row={row} kind={kind} now={now} pending={pending}
              selected={kind === "turn" && selected.get(row.id) === row.activity}
              onPick={(shift) => pick(row, shift)} onAddress={() => { void address([row]); }}
              onClear={() => { void act(() => rpc.call("clear_dispatch", { id: row.id })); }}
              onHold={(until) => { void act(() => rpc.call("hold", { id: row.id, activity: row.activity, until })); }}
              onDismiss={() => { void act(() => rpc.call("dismiss", { id: row.id, activity: row.activity, dismissed: kind !== "dismissed" })); }} />)}
          </ul>
        </section>)}
      </div>
    </section>)}
  </div>;
  const lastRead = view?.poll?.lastSuccess;
  return <div ref={rootRef} className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground", POINTER_CURSORS)}>
    <header className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/70 px-3 py-1">
      <h1 className="text-[13px] font-semibold">My PRs</h1>
      <button type="button" disabled={polling} onClick={() => { void poll(); }} aria-label="Refresh GitHub feedback"
        title={lastRead ? `Last read ${new Date(lastRead).toLocaleString()} · check GitHub now` : "Check GitHub now"}
        className={cn("ml-auto inline-flex min-w-0 items-center gap-1 rounded text-[11.5px] text-muted-foreground hover:text-foreground disabled:hover:text-inherit", RING)}>
        {polling ? <Spin /> : <span aria-hidden>↻</span>}
        <span className="truncate">{polling ? "Reading GitHub…" : lastRead ? `Last read ${age(Date.parse(lastRead), now)} ago` : "Not read yet"}</span>
      </button>
    </header>
    <div className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <main className={cn(COLUMN, "px-2 pb-10 pt-3 @min-[720px]:px-4")}>
        {error || view?.poll?.error ? <p role="alert" className="px-2 pb-3 text-[12px] text-destructive">{error ?? view?.poll?.error}</p> : null}
        {view === null ? <p role="status" className={EMPTY}>Reading the queue…</p> : <>
          <section aria-label="Your turn">
            <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/50 bg-background py-1 pl-2 pr-1">
              <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full bg-amber-500/70" />
              <ScopeCheckbox items={eligible} selected={selected} label="Select all actionable PRs" disabled={pending} onPick={pickScope} />
              <h2 className="truncate text-[12.5px] font-semibold">Your turn</h2>
              <span className={cn("min-w-[18px] rounded-full px-1.5 text-center text-[11px] tabular-nums", yours.length ? cn("font-semibold", AMBER) : "text-muted-foreground")}>{yours.length}</span>
            </div>
            {yours.length === 0 ? <p className={EMPTY}>Nothing waiting on you.</p> : renderGroups(yours, "turn")}
          </section>
          {dismissed.length > 0 ? <details className="mt-7 pb-1.5">
            <summary className={cn("ml-9 w-fit rounded-sm text-[11px] text-muted-foreground hover:text-foreground", RING)}>{dismissed.length} dismissed · show</summary>
            {renderGroups(dismissed, "dismissed")}
          </details> : null}
          {other.length > 0 ? <details className="mt-7 pb-1.5">
            <summary className={cn("ml-9 w-fit rounded-sm text-[11px] text-muted-foreground hover:text-foreground", RING)}>Other open PRs · {other.length}</summary>
            {renderGroups(other, "other")}
          </details> : null}
          {held.length > 0 ? <section aria-label="On hold" className="mt-7 opacity-60 hover:opacity-100 focus-within:opacity-100">
            <h2 className="ml-9 text-[12px] font-medium">On hold <span className="font-normal tabular-nums">{held.length}</span></h2>
            {renderGroups(held, "held")}
          </section> : null}
        </>}
      </main>
    </div>
    {chosen.length > 0 ? <div aria-label="Selection" className="shrink-0 border-t border-border bg-background">
      <div className={cn(COLUMN, "flex flex-wrap items-center gap-1.5 px-4 py-1.5 text-[12px]")}>
        <b className="mr-1 font-semibold">{chosen.length} selected</b>
        <button type="button" disabled={pending || chosen.length > 20} aria-busy={pending || undefined}
          aria-label={`Address ${chosen.length} selected`} title="Start one thread to address the selected PRs" onClick={() => { void address(chosen); }}
          className={cn(BUTTON, "border-foreground bg-foreground font-medium text-background")}>
          {pending ? <><Spin />Starting…</> : <>Address {chosen.length}<Kbd inverted>b</Kbd></>}
        </button>
        <span className="flex-1" />
        <span className="text-[11px] text-muted-foreground">{chosen.length > 20 ? "Select up to 20 PRs" : "One thread"}</span>
        <button type="button" onClick={() => setSelected(new Map())} className={GHOST}>Clear<Kbd>esc</Kbd></button>
      </div>
    </div> : null}
    {addressItems === null ? null : <AddressProjectDialog items={addressItems} onClose={() => setAddressItems(null)}
      onStart={(projectId) => startAddress(addressItems, projectId)} />}
  </div>;
}

function useInboxBadge(): ExperimentalBadge | null {
  const { view } = useInbox();
  const count = view?.rows.filter((row) => row.turn && !row.dismissed && !row.holdUntil).length ?? 0;
  return count > 0 ? { count, tone: "warning", label: `${count} pull request${count === 1 ? "" : "s"} waiting for your response` } : null;
}

function InboxCount() {
  const { view } = useInbox();
  return <span className={cn("inline-flex min-w-4 justify-center rounded px-1 py-1 text-[10px] font-medium leading-none", AMBER)}>{view?.rows.filter((row) => row.turn && !row.dismissed && !row.holdUntil).length ?? 0}</span>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "inbox", title: "My PRs", icon: "GitBranch", path: "inbox", component: InboxPage, experimental_useBadge: useInboxBadge, headerContent: InboxCount });
});
