import { useMemo } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { type Event, type InProgress } from "./contract.js";
import { formatLines, mergedPrs, prLines, sizeBucket, sizeSummary, type Sized } from "./size.js";

export function SizeTag({ item }: { item: Sized }) {
  const lines = prLines(item);
  if (lines === null || item.changedFiles === undefined) return null;
  const files = `${item.changedFiles} ${item.changedFiles === 1 ? "file" : "files"}`;
  return <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground" title={`${sizeBucket(lines)}: +${item.additions} −${item.deletions} lines across ${files}`}>{sizeBucket(lines)} · {formatLines(lines)} · {item.changedFiles}f</span>;
}

export function PrSize({ events, inProgress }: { events: Event[]; inProgress: InProgress[] }) {
  const merged = useMemo(() => sizeSummary(mergedPrs(events)), [events]);
  const open = useMemo(() => sizeSummary(inProgress), [inProgress]);
  const max = Math.max(1, ...merged.buckets.map(({ items }) => items.length));
  const missing = merged.known < merged.total || open.known < open.total;
  const description = merged.buckets.map(({ id, items }) => `${items.length} ${id}`).join(", ");
  return <details className="mb-5 border-b border-border pb-4 text-xs">
    <summary className="cursor-pointer list-none focus-visible:outline-2 focus-visible:outline-ring"><span className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <span className="font-medium">Merged PR size <span className="ml-1 text-muted-foreground">▸</span></span>
      <span className="flex h-7 items-end gap-2" role="img" aria-label={`Merged PRs by size: ${description}`}>{merged.buckets.map(({ id, items }) => <span key={id} className="flex w-7 flex-col items-center justify-end">
        <span className={`w-3 rounded-t-sm ${id === "L" || id === "XL" ? "bg-amber-600 dark:bg-amber-400" : "bg-blue-600 dark:bg-blue-400"}`} style={{ height: items.length ? `${Math.max(2, items.length / max * 18)}px` : "1px" }} />
        <span className="mt-0.5 font-mono text-[10px] leading-none text-muted-foreground">{id}</span>
      </span>)}</span>
      <span className="text-muted-foreground">{merged.known ? <>median {formatLines(merged.medianLines!)} lines · {merged.medianFiles} files · {Math.round(merged.largeShare! * 100)}% L/XL</> : merged.total ? "size appears after Refresh" : "no merged PRs"}</span>
      {open.known > 0 && <span className="text-muted-foreground" title="Lines changed across in-progress PRs, as of the snapshot">in progress: {formatLines(open.lines)} lines open across {open.known} PRs</span>}
    </span></summary>
    <div className="mt-3">
      <p className="mb-2 text-muted-foreground">Lines changed = additions + deletions, as GitHub reports them, including lockfiles and generated code. In-progress PRs use their size at fetch time.{missing && " Some cached PRs lack size data; Refresh to fill it."}</p>
      <div className="grid gap-3 sm:grid-cols-5">{merged.buckets.map(({ id, label, items }) => <section key={id} className="min-w-0">
        <h3 className="mb-1 font-medium">{id} <span className="font-mono text-muted-foreground">{items.length}</span></h3>
        <p className="mb-1 text-muted-foreground">{label}</p>
        {items.length ? <ul className="space-y-1">{items.map((item) => <li key={item.url} className="min-w-0 truncate"><span className="font-mono text-muted-foreground">{formatLines(prLines(item)!)}</span> <UrlLink href={item.url} className="text-foreground underline-offset-2 hover:underline" title={`${item.repo} #${item.number} · ${item.title} · ${item.login}`}>#{item.number} · {item.title}</UrlLink></li>)}</ul> : <p className="text-muted-foreground">No PRs</p>}
      </section>)}</div>
    </div>
  </details>;
}
