import { useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { dailyCounts, etDate, eventsOnEtDay, flowScore, inProgressAgeDays, inProgressChange, mondayEt, weekBounds, weekNote } from "./activity.js";
import { type Event, type InProgress, type Result, type SnapshotResult, type rpcContract } from "./contract.js";
import { ReviewConnections } from "./ConnectionsPanel.js";
import { Postcard } from "./PostcardPanel.js";
import { PrSize, SizeTag } from "./SizePanel.js";
import { formatLines, reviewLoad, type ReviewLoad } from "./size.js";

type Org = "parsleyhealth" | "bitcomplete" | "ira-cscc";
type Metric = Event["metric"];
const orgs: { id: Org; label: string }[] = [
  { id: "parsleyhealth", label: "Parsley Health" },
  { id: "bitcomplete", label: "Bit Complete" },
  { id: "ira-cscc", label: "Cscc" },
];
const columns: { id: Metric; label: string; help: string }[] = [
  { id: "opened", label: "Opened", help: "PRs created by the contributor during the week." },
  { id: "merged", label: "Merged", help: "PRs authored by the contributor and merged during the week." },
  { id: "reviewed", label: "Reviewed", help: "Distinct PRs reviewed by the contributor during the week, including PRs opened earlier. Repeat submissions on one PR count once, on the latest review day. Pending reviews do not count." },
  { id: "closed", label: "Closed", help: "PRs authored by the contributor and closed without merging during the week." },
];
const inProgressHelp = "PRs authored by the contributor, created within the 90 days before the snapshot, and open at the end of the selected week, including drafts. The current week shows PRs open when the data was fetched.";
const flowHelp = "Opened + 2 × merged + 0.5 × distinct PRs reviewed − 0.25 × any increase in 90-day in-progress PRs from the previous week. Requires the previous-week snapshot.";
const reviewLoadHelp = "Lines changed (additions + deletions) across the distinct PRs the contributor reviewed during the week, at each PR's current size. Each PR counts once per reviewer.";
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CACHE_TTL_MS = 24 * 60 * 60_000;
const resultCache = new Map<string, { at: number; result: Extract<Result, { ok: true }> }>();
const defaultWeek = mondayEt(new Date());
let selectedOrg: Org = "parsleyhealth";
let selectedWeek = defaultWeek;
function cacheKey(org: Org, week: string) { return `${org}:${week}`; }
function cachedResult(org: Org, week: string) {
  const key = cacheKey(org, week);
  const entry = resultCache.get(key);
  if (!entry) return undefined;
  const expiresAt = mondayEt(new Date(entry.result.fetchedAt)) === week
    ? Math.min(entry.at + CACHE_TTL_MS, Date.parse(weekBounds(week).end))
    : entry.at + CACHE_TTL_MS;
  if (Date.now() >= expiresAt) {
    resultCache.delete(key);
    return undefined;
  }
  return entry.result;
}
const fetchedAtFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
function DayBars({ counts, label, compact = false, scaleMax, activeDay, selectedDay, onSelect, onHover }: { counts: number[]; label: string; compact?: boolean; scaleMax?: number; activeDay?: number | null; selectedDay?: number | null; onSelect?: (day: number) => void; onHover?: (day: number | null) => void }) {
  const max = scaleMax ?? Math.max(1, ...counts);
  const description = counts.map((count, day) => `${days[day]} ${count}`).join(", ");
  return <div role={compact ? "img" : "group"} aria-label={`${label}: ${description}`} className={`flex items-end ${compact ? "h-7 gap-1" : "h-[76px] gap-3"}`}>
    {counts.map((count, day) => {
      const className = `flex h-full flex-col items-center justify-end ${compact ? "min-w-1 flex-1" : "w-7 shrink-0"} ${activeDay === day ? "rounded-sm bg-blue-500/15 ring-1 ring-blue-500/40" : ""}`;
      const content = <>
      <div className={`relative ${count ? "bg-blue-600 dark:bg-blue-400" : "bg-muted-foreground/25"} ${compact ? "w-full" : "w-1.5 rounded-t-sm"}`} style={{ height: count ? `${Math.max(compact ? 1 : 3, count / max * (compact ? 28 : 42))}px` : "1px" }}>
        {!compact && count > 0 && <span className="absolute -top-4 left-1/2 -translate-x-1/2 font-mono text-[10px] leading-none text-foreground">{count}</span>}
      </div>
      {!compact && <span className="mt-1 text-center font-mono text-[10px] text-muted-foreground">{days[day]}</span>}
      </>;
      return compact ? <div key={day} title={`${days[day]}: ${count}`} className={className}>{content}</div>
        : <button key={day} type="button" aria-label={`${days[day]}: ${count} activities; show day details`} aria-pressed={selectedDay === day} title={`${days[day]}: ${count}`} onClick={() => onSelect?.(day)} onMouseEnter={() => onHover?.(day)} onMouseLeave={() => onHover?.(null)} onFocus={() => onHover?.(day)} onBlur={() => onHover?.(null)} className={`${className} cursor-pointer focus-visible:outline-2 focus-visible:outline-ring`}>{content}</button>;
    })}
  </div>;
}
function shift(week: string, weeks: number) {
  const date = new Date(`${week}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}
function Trend({ current, previous, label }: { current: number; previous: number; label: string }) {
  const { delta, percent } = inProgressChange(current, previous);
  const change = `${delta > 0 ? "+" : ""}${delta}`;
  const percentText = percent === null ? "no percentage baseline" : `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
  const title = `${label}: previous ${previous}, current ${current}, change ${change} (${percentText}). Counts use rolling 90-day windows; older PRs can age out.`;
  const max = Math.max(1, current, previous);
  return <span className="inline-flex items-end gap-1" role="img" aria-label={title} title={title}>
    <span className="inline-flex h-5 items-end gap-0.5" aria-hidden="true">{[previous, current].map((count, index) => <span key={index} className={`w-1.5 rounded-t-sm ${index ? "bg-blue-600 dark:bg-blue-400" : "bg-muted-foreground/40"}`} style={{ height: `${Math.max(2, count / max * 20)}px` }} />)}</span>
    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{change}</span>
  </span>;
}
function AgeStrip({ items, week, fetchedAt, current }: { items: InProgress[]; week: string; fetchedAt: string; current: boolean }) {
  const aged = items.map((item) => ({ item, age: inProgressAgeDays(item, week, fetchedAt, current) })).sort((a, b) => b.age - a.age || a.item.url.localeCompare(b.item.url));
  const ranges = [{ label: "0–7 days", items: aged.filter(({ age }) => age <= 7) }, { label: "8–30 days", items: aged.filter(({ age }) => age > 7 && age <= 30) }, { label: "31–90 days", items: aged.filter(({ age }) => age > 30) }];
  const bins = Array.from({ length: 91 }, () => 0);
  for (const { age } of aged) bins[Math.min(90, age)]++;
  const maxBin = Math.max(1, ...bins);
  return <details className="mb-5 border-b border-border pb-4 text-xs">
    <summary className="cursor-pointer list-none focus-visible:outline-2 focus-visible:outline-ring"><span className="flex flex-wrap items-center gap-x-5 gap-y-2"><span className="font-medium">In-progress age <span className="ml-1 text-muted-foreground">▸</span></span><span className="block w-[340px] max-w-full"><span className="relative block h-6 border-b border-border" role="img" aria-label={`${items.length} in-progress PRs by age; ${ranges.map(({ label, items: group }) => `${group.length} at ${label}`).join(", ")}`}><span className="absolute bottom-0 left-[7.8%] h-5 border-l border-border/70" /><span className="absolute bottom-0 left-1/3 h-5 border-l border-border/70" />{bins.map((count, age) => count > 0 && <span key={age} className={`absolute bottom-0 w-0.5 ${age > 30 ? "bg-amber-600 dark:bg-amber-400" : "bg-blue-600 dark:bg-blue-400"}`} style={{ left: `${age / 90 * 100}%`, height: `${Math.max(2, count / maxBin * 20)}px` }} />)}</span><span className="relative block h-3 font-mono text-[10px] text-muted-foreground"><span className="absolute left-0">0</span><span className="absolute left-[7.8%] -translate-x-1/2">7</span><span className="absolute left-1/3 -translate-x-1/2">30</span><span className="absolute right-0">90d</span></span></span><span className="text-muted-foreground">{items.length} PRs · inspect ages</span></span></summary>
    <div className="mt-3 grid gap-3 sm:grid-cols-3">{ranges.map(({ label, items: group }) => {
      const repos = new Map<string, typeof group>();
      for (const entry of group) {
        const entries = repos.get(entry.item.repo) ?? [];
        entries.push(entry);
        repos.set(entry.item.repo, entries);
      }
      return <section key={label}><h3 className="mb-1 font-medium">{label} <span className="font-mono text-muted-foreground">{group.length}</span></h3>{group.length ? [...repos].map(([repo, entries]) => <details key={repo} className="mb-1"><summary className="cursor-pointer text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">{repo} · {entries.length} · oldest {entries[0].age}d</summary><ul className="space-y-1 pl-4 pt-1">{entries.map(({ item, age }) => <li key={item.url} className="min-w-0"><span className="font-mono text-muted-foreground">{age}d</span> <UrlLink href={item.url} className="text-foreground underline-offset-2 hover:underline" title={item.title}>#{item.number} · {item.title}</UrlLink></li>)}</ul></details>) : <p className="text-muted-foreground">No PRs</p>}</section>;
    })}</div>
  </details>;
}
function ReviewLoadCell({ load }: { load?: ReviewLoad }) {
  if (!load) return <span className="text-center font-mono text-sm text-muted-foreground/50">·</span>;
  if (load.known === 0) return <span className="text-center font-mono text-sm text-muted-foreground" title="Refresh to load PR sizes.">—</span>;
  const partial = load.known < load.prs ? ` Size data covers ${load.known} of ${load.prs} PRs; refresh to fill it.` : "";
  return <span className="text-center font-mono text-sm tabular-nums" title={`${load.lines.toLocaleString("en-US")} lines across ${load.files} files in ${load.prs} reviewed ${load.prs === 1 ? "PR" : "PRs"}.${partial}`}>{formatLines(load.lines)}{partial && "*"}</span>;
}
function Contributor({ login, events, inProgress, previousInProgress, load, week, dailyScaleMax, activeDay, selectedDay }: { login: string; events: Event[]; inProgress: InProgress[]; previousInProgress?: number; load?: ReviewLoad; week: string; dailyScaleMax: number; activeDay: number | null; selectedDay: number | null }) {
  const counts = [events.filter((event) => event.metric === "opened").length, inProgress.length,
    ...columns.slice(1).map(({ id }) => events.filter((event) => event.metric === id).length)];
  const [open, setOpen] = useState(false);
  const detailEvents = selectedDay === null ? events : eventsOnEtDay(events, week, selectedDay);
  const repos = useMemo(() => {
    const groups = new Map<string, { events: Event[]; inProgress: InProgress[] }>();
    for (const event of detailEvents) {
      const group = groups.get(event.repo) ?? { events: [], inProgress: [] };
      group.events.push(event);
      groups.set(event.repo, group);
    }
    for (const item of selectedDay === null ? inProgress : []) {
      const group = groups.get(item.repo) ?? { events: [], inProgress: [] };
      group.inProgress.push(item);
      groups.set(item.repo, group);
    }
    return [...groups].sort((a, b) => b[1].events.length + b[1].inProgress.length - a[1].events.length - a[1].inProgress.length || a[0].localeCompare(b[0]));
  }, [detailEvents, inProgress, selectedDay]);
  return (
    <div className="border-b border-border/60 last:border-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="grid w-full grid-cols-[minmax(12rem,1fr)_repeat(5,5.5rem)_4.5rem_5.5rem_6rem] items-center gap-2 px-4 py-2.5 text-left hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring">
        <span className="min-w-0 truncate font-medium text-foreground"><span className="mr-2 text-muted-foreground">{open ? "▾" : "▸"}</span>{login}</span>
        {counts.map((count, index) => <span key={index} className={`flex items-center justify-center gap-1 font-mono text-sm tabular-nums ${count ? "text-foreground" : "text-muted-foreground/50"}`}><span>{count || "·"}</span>{index === 1 && previousInProgress !== undefined && <Trend current={count} previous={previousInProgress} label={`${login} 90-day in-progress trend`} />}</span>)}
        <span className="text-center font-mono text-sm tabular-nums" title={previousInProgress === undefined ? "Flow requires the previous-week in-progress snapshot." : flowHelp}>{previousInProgress === undefined ? "—" : flowScore(events, inProgress.length, previousInProgress).toFixed(1)}</span>
        <ReviewLoadCell load={load} />
        <DayBars counts={dailyCounts(events, week)} label={`${login} daily PR activity`} compact scaleMax={dailyScaleMax} activeDay={activeDay} />
      </button>
      {open && <div className="bg-foreground/[0.025] px-6 pb-3 pt-1">
        {repos.map(([repo, group]) => <details key={repo} className="border-b border-border/50 py-2 last:border-0">
          <summary className="cursor-pointer text-xs text-foreground marker:text-muted-foreground"><span className="ml-1 font-medium">{repo}</span><span className="ml-3 font-mono tabular-nums text-muted-foreground">{[{ label: "In progress", count: group.inProgress.length }, ...columns.map(({ id, label }) => ({ label, count: group.events.filter((event) => event.metric === id).length }))].filter(({ count }) => count > 0).map(({ label, count }) => `${label} ${count}`).join(" · ")}</span></summary>
          <div className="pl-5 pt-2">
            {group.inProgress.length > 0 && <section className="mb-2"><h3 className="text-[11px] font-medium text-muted-foreground">In progress</h3><ul>{group.inProgress.map((item) => <li key={item.url} className="flex min-w-0 items-baseline gap-2 text-xs leading-5"><span className="w-12 shrink-0 font-mono text-muted-foreground">{etDate(new Date(item.createdAt)).slice(5)}</span><UrlLink href={item.url} className="min-w-0 truncate text-foreground underline-offset-2 hover:underline" title={item.title}>#{item.number} · {item.title}</UrlLink>{item.isDraft && <span className="shrink-0 text-muted-foreground">Draft</span>}<SizeTag item={item} /></li>)}</ul></section>}
            {columns.map(({ id, label }) => {
            const matches = group.events.filter((event) => event.metric === id);
            if (!matches.length) return null;
            return <section key={id} className="mb-2"><h3 className="text-[11px] font-medium text-muted-foreground">{label}</h3><ul>{matches.map((event) => <li key={event.id} className="flex min-w-0 items-baseline gap-2 text-xs leading-5"><span className="w-12 shrink-0 font-mono text-muted-foreground">{etDate(new Date(event.at)).slice(5)}</span><UrlLink href={event.url} className="min-w-0 truncate text-foreground underline-offset-2 hover:underline" title={event.title}>#{event.number} · {event.title}</UrlLink><SizeTag item={event} /></li>)}</ul></section>;
          })}</div>
        </details>)}
      </div>}
    </div>
  );
}
function Dashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const [org, setOrg] = useState<Org>(selectedOrg);
  const [week, setWeek] = useState(selectedWeek);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [hoveredDay, setHoveredDay] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const refreshNext = useRef(false);
  const refreshPrior = useRef("");
  const initialResult = cachedResult(org, week);
  const [state, setState] = useState<{ key: string; result: Result } | null>(() => initialResult ? { key: cacheKey(org, week), result: initialResult } : null);
  const [loading, setLoading] = useState(() => !initialResult);
  const [priorState, setPriorState] = useState<{ key: string; result: SnapshotResult } | null>(null);
  const key = cacheKey(org, week);
  const select = (nextOrg: Org, nextWeek: string) => {
    selectedOrg = nextOrg;
    selectedWeek = nextWeek;
    const cached = cachedResult(nextOrg, nextWeek);
    setState(cached ? { key: cacheKey(nextOrg, nextWeek), result: cached } : null);
    setPriorState(null);
    setLoading(!cached);
    setOrg(nextOrg);
    setWeek(nextWeek);
    setSelectedDay(null);
    setHoveredDay(null);
  };
  useEffect(() => {
    let active = true;
    const refresh = refreshNext.current;
    refreshNext.current = false;
    const cached = !refresh && cachedResult(org, week);
    if (cached) {
      setState({ key, result: cached });
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setState(null);
    rpc.call("activity_get", { org, week, refresh }).then(
      (result) => {
        if (result.ok) resultCache.set(key, { at: Date.now(), result });
        if (active) { setState({ key, result }); setLoading(false); }
      },
      (error: unknown) => { if (active) { setState({ key, result: { ok: false, error: error instanceof Error ? error.message : "Could not load activity." } }); setLoading(false); } },
    );
    return () => { active = false; };
  }, [rpc, org, week, reload, key]);
  const stateForSelection = state?.key === key ? state.result : null;
  const selectedFetchedAt = stateForSelection?.ok ? stateForSelection.fetchedAt : null;
  useEffect(() => {
    if (!selectedFetchedAt) return;
    let active = true;
    const previousWeek = shift(week, -1);
    const priorKey = cacheKey(org, previousWeek);
    setPriorState(null);
    rpc.call("in_progress_get", { org, week: previousWeek, refresh: refreshPrior.current === `${key}:${reload}` }).then(
      (result) => { if (active) setPriorState({ key: priorKey, result }); },
      (error: unknown) => { if (active) setPriorState({ key: priorKey, result: { ok: false, error: error instanceof Error ? error.message : "Could not load the previous snapshot." } }); },
    );
    return () => { active = false; };
  }, [rpc, org, week, key, reload, selectedFetchedAt]);
  const previous = priorState?.key === cacheKey(org, shift(week, -1)) && priorState.result.ok ? priorState.result.inProgress : undefined;
  const previousByLogin = useMemo(() => {
    if (!previous) return undefined;
    const counts = new Map<string, number>();
    for (const item of previous) counts.set(item.login, (counts.get(item.login) ?? 0) + 1);
    return counts;
  }, [previous]);
  const contributors = useMemo(() => {
    if (!stateForSelection?.ok) return [];
    const groups = new Map<string, { events: Event[]; inProgress: InProgress[] }>();
    for (const event of stateForSelection.events) {
      const group = groups.get(event.login) ?? { events: [], inProgress: [] };
      group.events.push(event);
      groups.set(event.login, group);
    }
    for (const item of stateForSelection.inProgress) {
      const group = groups.get(item.login) ?? { events: [], inProgress: [] };
      group.inProgress.push(item);
      groups.set(item.login, group);
    }
    return [...groups].sort((a, b) => b[1].events.length + b[1].inProgress.length - a[1].events.length - a[1].inProgress.length || a[0].localeCompare(b[0]));
  }, [stateForSelection]);
  const loads = useMemo(() => stateForSelection?.ok ? reviewLoad(stateForSelection.events) : new Map<string, ReviewLoad>(), [stateForSelection]);
  const dailyScaleMax = useMemo(() => Math.max(1, ...contributors.map(([, group]) => Math.max(...dailyCounts(group.events, week)))), [contributors, week]);
  const activeDay = hoveredDay ?? selectedDay;
  const visibleContributors = selectedDay === null ? contributors : contributors.filter(([, group]) => eventsOnEtDay(group.events, week, selectedDay).length > 0);
  const { endDate } = weekBounds(week);
  const isCurrent = week === mondayEt(new Date());
  return <div className="h-full overflow-y-auto bg-background text-foreground">
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-6 lg:px-8">
      <header className="mb-6 border-b border-border/70 pb-5">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">GitHub · Weekly activity</p>
        <h1 className="text-2xl font-semibold tracking-tight">Repo Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">Pull request activity by contributor across each organization.</p>
      </header>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="GitHub organization" className="inline-flex rounded-md border border-border bg-muted/40 p-1">
          {orgs.map((choice) => <button key={choice.id} type="button" role="tab" aria-selected={org === choice.id} onClick={() => select(choice.id, week)} className={`rounded px-3 py-1.5 text-sm ${org === choice.id ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{choice.label}</button>)}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button type="button" aria-label="Previous week" onClick={() => select(org, shift(week, -1))} className="rounded border border-border px-2 py-1 hover:bg-muted">←</button>
          <span className="min-w-48 text-center font-mono text-xs tabular-nums">{week} – {new Date(Date.parse(`${endDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)}</span>
          <button type="button" aria-label="Next week" disabled={isCurrent} onClick={() => select(org, shift(week, 1))} className="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-40">→</button>
          <button type="button" aria-label="Refresh GitHub activity" title="Fetch fresh GitHub activity and update the cache" onClick={() => { refreshNext.current = true; refreshPrior.current = `${key}:${reload + 1}`; setState(null); setPriorState(null); setLoading(true); setReload((value) => value + 1); }} disabled={loading} className="ml-2 rounded border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-40">Refresh</button>
        </div>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">Monday–Sunday · Eastern Time · Bots excluded{org === "ira-cscc" && <> · Cscc maps to <span className="font-mono">ira-cscc</span></>}</p>
      {loading && !stateForSelection ? <div role="status" className="rounded-lg border border-border p-8 text-sm text-muted-foreground">Loading GitHub activity…</div> : stateForSelection && !stateForSelection.ok ? <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-5 text-sm text-destructive"><strong>Activity unavailable.</strong> {stateForSelection.error}</div> : stateForSelection?.ok ? <>
        <section aria-label="Organization activity by day" className="mb-3 flex flex-wrap items-center gap-x-10 gap-y-2 border-y border-border py-3"><div className="min-w-36"><h2 className="text-xs font-medium text-foreground">Activity by day</h2><p className="mt-1 font-mono text-xl tabular-nums text-foreground">{stateForSelection.events.length}<span className="ml-2 text-[11px] font-normal text-muted-foreground">activities</span></p></div><DayBars counts={dailyCounts(stateForSelection.events, week)} label="Organization daily PR activity" activeDay={activeDay} selectedDay={selectedDay} onSelect={(day) => setSelectedDay(selectedDay === day ? null : day)} onHover={setHoveredDay} /><div className="min-w-44"><h2 className="text-xs font-medium text-foreground">90-day in-progress trend</h2><p className="mt-1 flex items-baseline gap-3"><span className="font-mono text-xl tabular-nums">{stateForSelection.inProgress.length}</span>{previous ? <Trend current={stateForSelection.inProgress.length} previous={previous.length} label="Organization 90-day in-progress trend" /> : <span className="text-xs text-muted-foreground" title={priorState?.result.ok === false ? priorState.result.error : "Loading previous-week snapshot"}>—</span>}</p><p className="text-[11px] text-muted-foreground">{isCurrent ? "Fetch-time snapshot" : "Week-end snapshot"} · change from previous week</p></div></section>
        <p className="mb-3 text-xs text-muted-foreground">{weekNote(stateForSelection.events, week, isCurrent, stateForSelection.inProgress.length, previous?.length)}</p>
        <AgeStrip items={stateForSelection.inProgress} week={week} fetchedAt={stateForSelection.fetchedAt} current={isCurrent} />
        <PrSize events={stateForSelection.events} inProgress={stateForSelection.inProgress} />
        <ReviewConnections events={stateForSelection.events} week={week} />
        {selectedDay !== null && <p className="mb-3 flex items-center gap-3 text-xs"><span className="font-medium">{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][selectedDay]} details · counts remain weekly</span><button type="button" onClick={() => setSelectedDay(null)} className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">Clear day</button></p>}
        {priorState?.key === cacheKey(org, shift(week, -1)) && !priorState.result.ok && <p role="status" className="mb-3 text-xs text-muted-foreground">Previous-week in-progress snapshot unavailable: {priorState.result.error} Flow scores require this snapshot.</p>}
        <div className="overflow-x-auto border-y border-border"><div className="min-w-[984px]">
          <div className="grid grid-cols-[minmax(12rem,1fr)_repeat(5,5.5rem)_4.5rem_5.5rem_6rem] gap-2 border-b border-border bg-muted/40 px-4 py-2.5 text-xs font-medium text-muted-foreground"><span>Contributor</span><span className="text-center" title={columns[0].help}>Opened</span><span className="text-center" title={inProgressHelp}>In progress</span>{columns.slice(1).map((column) => <span key={column.id} className="text-center" title={column.help}>{column.label}</span>)}<span className="text-center" title={flowHelp}>Flow</span><span className="text-center" title={reviewLoadHelp}>Lines reviewed</span><span className="text-center" title="Daily PR activity uses the same scale across all contributors.">Mon–Sun</span></div>
          {visibleContributors.length ? visibleContributors.map(([login, group]) => <Contributor key={login} login={login} events={group.events} inProgress={group.inProgress} previousInProgress={previousByLogin?.get(login) ?? (previousByLogin ? 0 : undefined)} load={loads.get(login)} week={week} dailyScaleMax={dailyScaleMax} activeDay={activeDay} selectedDay={selectedDay} />) : <p className="px-4 py-8 text-sm text-muted-foreground">{selectedDay === null ? "No activity found for this week." : "No PR activity on this day."}</p>}
        </div></div>
        <div className="mt-4 grid gap-2 text-xs leading-5 text-muted-foreground sm:grid-cols-2"><p><strong className="text-foreground">In progress:</strong> {inProgressHelp} The 90-day in-progress trend compares two rolling snapshots, so PRs can leave the window without being completed.</p>{columns.map((column) => <p key={column.id}><strong className="text-foreground">{column.label}:</strong> {column.help}</p>)}<p><strong className="text-foreground">Flow:</strong> {flowHelp}</p><p><strong className="text-foreground">Lines reviewed:</strong> {reviewLoadHelp}</p></div>
        <p className="mt-4 text-[11px] text-muted-foreground">{contributors.length} contributors · {stateForSelection.events.length} activities · Updated {fetchedAtFormatter.format(new Date(stateForSelection.fetchedAt))}</p>
        <Postcard key={key} org={org} orgLabel={orgs.find((choice) => choice.id === org)!.label} week={week} fetchedAt={stateForSelection.fetchedAt} current={isCurrent} events={stateForSelection.events} inProgress={stateForSelection.inProgress.length} previousInProgress={previous?.length} inProgressItems={stateForSelection.inProgress} previousInProgressItems={previous} />
      </> : null}
    </div>
  </div>;
}
export default definePluginApp((app) => {
  app.slots.navPanel({ id: "repo-dashboard", title: "Repo Dashboard", icon: "GithubLogo", path: "repo-dashboard", component: Dashboard });
});
