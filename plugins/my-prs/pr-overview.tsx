import { PR_STATUSES, prStatus } from "./pr-status.js";
import type { Row } from "./types.js";

export function PrOverview({ rows, now }: { rows: Row[]; now: number }) {
  const groups = PR_STATUSES.map((status) => ({ ...status, rows: rows.filter((row) => prStatus(row) === status.key) }))
    .filter((status) => status.key !== "unknown" || status.rows.length > 0);
  const waiting = rows.filter((row) => prStatus(row) === "waiting");
  const old = waiting.filter((row) => now - Date.parse(row.updatedAt) >= 4 * 86_400_000).length;
  return <section aria-label="PR overview" className="mb-5 px-2 text-[12px]">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold tabular-nums">{rows.length} open PR{rows.length === 1 ? "" : "s"}</h2>
      <span className="text-[11px] text-muted-foreground">who has the ball</span>
    </div>
    {rows.length > 0 ? <div role="img" aria-label={groups.map((group) => `${group.label}: ${group.rows.length}`).join(", ")}
      className="grid h-3.5" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))`, gap: `min(2px, ${20 / rows.length}%)` }}>
      {groups.flatMap((group) => group.rows.map((row) => <span key={row.id} title={`${row.repo}#${row.number} · ${group.label}`}
        className={`min-w-0 rounded-[2px] ${group.color}`} />))}
    </div> : null}
    <ul aria-label="PR status counts" className="mt-2 flex list-none flex-wrap gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
      {groups.map((group) => <li key={group.key} className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`h-2.5 w-2 shrink-0 rounded-[2px] ${group.color}`} />
        {group.label}<b className="font-semibold tabular-nums text-foreground/80">{group.rows.length}</b>
      </li>)}
    </ul>
    {waiting.length > 0 ? <p className="mt-3 inline-flex flex-wrap items-center gap-x-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-muted-foreground">
      Waiting on reviewers <b className="font-semibold tabular-nums text-foreground/80">{waiting.length}</b>
      {old > 0 ? <span title="Based on the last GitHub update">· {old} at 4d+</span> : null}
    </p> : null}
  </section>;
}
