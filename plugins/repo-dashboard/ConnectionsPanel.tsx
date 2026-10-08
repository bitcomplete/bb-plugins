import { useMemo } from "react";
import { type Event } from "./contract.js";
import { connectionKey, reviewConnections } from "./connections.js";

export function ReviewConnections({ events, week }: { events: Event[]; week: string }) {
  const data = useMemo(() => reviewConnections(events, week), [events, week]);
  const limited = new Set([...data.reviewers, ...data.authors]).size > 40;
  const reviewers = limited ? data.reviewers.slice(0, 20) : data.reviewers;
  const authors = limited ? data.authors.slice(0, 20) : data.authors;
  return <details className="mb-5 border-b border-border pb-4 text-xs">
    <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-ring">Review connections <span className="ml-2 font-normal text-muted-foreground">{data.cells.size} reviewer–author pairs · {data.known}/{data.total} reviewed PR contributions have author data</span></summary>
    <div className="mt-3">
      {data.total > 0 && data.known < data.total && <p className="mb-2 text-muted-foreground">{data.known === 0 ? "Author connections appear after the next refresh." : `Author data covers ${data.known} of ${data.total} reviewed PR contributions. Refresh to fill older cached entries.`}</p>}
      {data.cells.size === 0 ? <p className="text-muted-foreground">{data.total > 0 && data.known === 0 ? "No author data in this snapshot." : "No reviewer-to-author connections this week."}</p> : <>
        <p className="mb-2 text-muted-foreground">Distinct PRs reviewed, not approvals. Color uses one scale across the table.</p>
        {limited && <p className="mb-2 text-muted-foreground">Showing the top 20 reviewers and authors by reviewed PR contributions ({data.reviewers.length} reviewers, {data.authors.length} authors total).</p>}
        <div className="max-h-72 max-w-full overflow-auto rounded border border-border">
          <table className="border-collapse text-[11px]">
            <caption className="sr-only">Reviewed PR contributions from reviewers in rows to PR authors in columns</caption>
            <thead><tr><th scope="col" className="sticky left-0 top-0 z-20 min-w-28 bg-background p-1 text-left font-medium">Reviewer ↓ Author →</th>{authors.map((author) => <th key={author} scope="col" title={author} className="sticky top-0 z-10 min-w-12 max-w-24 truncate bg-background p-1 text-center font-medium">{author}</th>)}</tr></thead>
            <tbody>{reviewers.map((reviewer) => <tr key={reviewer}><th scope="row" title={reviewer} className="sticky left-0 z-10 max-w-28 truncate bg-background p-1 text-left font-medium">{reviewer}</th>{authors.map((author) => {
              const count = data.cells.get(connectionKey(reviewer, author)) ?? 0;
              return <td key={author} title={`${reviewer} reviewed ${count} distinct ${author} PR${count === 1 ? "" : "s"}`} className="p-0.5 text-center font-mono tabular-nums"><span className="block min-w-10 rounded py-1" style={{ backgroundColor: count ? `rgba(37, 99, 235, ${0.12 + 0.5 * count / data.max})` : undefined }}>{count || "·"}</span></td>;
            })}</tr>)}</tbody>
          </table>
        </div>
      </>}
    </div>
  </details>;
}
