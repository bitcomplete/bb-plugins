import { PR_STATUSES, prStatus, type PrStatus } from "./pr-status.js";
import { cn } from "./lib/utils.js";
import type { Row } from "./types.js";

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-sky-500";

export function PrOverview({ rows, now, filter, onFilter }: {
  rows: Row[]; now: number; filter: PrStatus | null; onFilter: (status: PrStatus | null) => void;
}) {
  const groups = PR_STATUSES.map((status) => ({ ...status, rows: rows.filter((row) => prStatus(row) === status.key) }))
    .filter((status) => status.key !== "unknown" || status.rows.length > 0);
  const waiting = rows.filter((row) => prStatus(row) === "waiting");
  const old = waiting.filter((row) => now - Date.parse(row.updatedAt) >= 4 * 86_400_000).length;
  return <section aria-label="PR overview" className="mb-5 px-2 text-[12px]">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold tabular-nums">{rows.length} open PR{rows.length === 1 ? "" : "s"}</h2>
      {filter === null ? <span className="text-[11px] text-muted-foreground">Click a state to filter</span> :
        <button type="button" onClick={() => onFilter(null)} aria-label="Show all PRs"
          className={cn("rounded px-2 py-1 text-[11px] text-sky-600 hover:bg-sky-500/10 dark:text-sky-400", FOCUS)}>Show all PRs ×</button>}
    </div>
    {rows.length > 0 ? <div role="group" aria-label="Filter by PR state" className="flex gap-0.5">
      {groups.filter((group) => group.rows.length > 0).map((group) => <button key={group.key} type="button"
        aria-label={`Filter ${group.label}: ${group.rows.length}`} aria-pressed={filter === group.key}
        onClick={() => onFilter(filter === group.key ? null : group.key)}
        title={`${group.label}: ${group.rows.length} · click to ${filter === group.key ? "show all" : "filter"}`}
        className={cn("grid h-8 min-w-0 rounded py-2 hover:brightness-125", FOCUS,
          filter !== null && filter !== group.key && "opacity-30")}
        style={{ flex: `${group.rows.length} 1 0%`, gridTemplateColumns: `repeat(${group.rows.length}, minmax(0, 1fr))`, gap: `min(2px, ${20 / group.rows.length}%)` }}>
        {group.rows.map((row) => <span key={row.id} title={`${row.repo}#${row.number} · ${group.label}`}
          className={`block h-3.5 min-w-0 rounded-[2px] ${group.color}`} />)}
      </button>)}
    </div> : null}
    <ul aria-label="PR status counts" className="flex list-none flex-wrap gap-1 text-[11px] text-muted-foreground">
      {groups.map((group) => <li key={group.key}>
        <button type="button" aria-label={`${group.label}: ${group.rows.length}`} aria-pressed={filter === group.key}
          disabled={group.rows.length === 0 && filter !== group.key} onClick={() => onFilter(filter === group.key ? null : group.key)}
          className={cn("inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 py-1 hover:bg-foreground/[0.05] disabled:opacity-40", FOCUS,
            filter === group.key ? "border-foreground/30 bg-foreground/[0.06] font-medium text-foreground" : "border-transparent")}>
          <span aria-hidden className={`h-2.5 w-2 shrink-0 rounded-[2px] ${group.color}`} />
          {group.label}<b className="font-semibold tabular-nums text-foreground/80">{group.rows.length}</b>
        </button>
      </li>)}
    </ul>
    {waiting.length > 0 ? <button type="button" onClick={() => onFilter(filter === "waiting" ? null : "waiting")}
      aria-pressed={filter === "waiting"} className={cn("mt-3 inline-flex flex-wrap items-center gap-x-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-muted-foreground hover:bg-foreground/[0.05]", FOCUS)}>
      Waiting on reviewers <b className="font-semibold tabular-nums text-foreground/80">{waiting.length}</b>
      {old > 0 ? <span title="Based on the last GitHub update">· {old} at 4d+</span> : null}
    </button> : null}
  </section>;
}
