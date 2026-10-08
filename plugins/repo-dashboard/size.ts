import { type Event } from "./contract.js";

export type Sized = { url: string; additions?: number; deletions?: number; changedFiles?: number };
export type SizeBucket = "XS" | "S" | "M" | "L" | "XL";
// Lines changed (additions + deletions) below each limit; XL has no limit.
export const sizeBuckets: { id: SizeBucket; below: number; label: string }[] = [
  { id: "XS", below: 10, label: "under 10 lines" },
  { id: "S", below: 50, label: "10–49 lines" },
  { id: "M", below: 250, label: "50–249 lines" },
  { id: "L", below: 1000, label: "250–999 lines" },
  { id: "XL", below: Infinity, label: "1,000+ lines" },
];

export function prLines(item: Sized): number | null {
  return item.additions === undefined || item.deletions === undefined ? null : item.additions + item.deletions;
}
export function sizeBucket(lines: number): SizeBucket {
  return sizeBuckets.find(({ below }) => lines < below)!.id;
}
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function formatLines(lines: number): string {
  if (lines < 1000) return String(Math.round(lines));
  const thousands = lines / 1000;
  return `${thousands < 100 ? thousands.toFixed(1).replace(/\.0$/u, "") : Math.round(thousands)}k`;
}
function distinct<T extends Sized>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.url, item])).values()];
}

export type SizeSummary<T extends Sized> = {
  total: number; known: number; medianLines: number | null; medianFiles: number | null; lines: number;
  buckets: { id: SizeBucket; label: string; items: T[] }[]; largeShare: number | null;
};
/** Size distribution of distinct PRs; PRs without size data count toward total but not known. */
export function sizeSummary<T extends Sized>(items: T[]): SizeSummary<T> {
  const prs = distinct(items);
  const sized = prs.filter((item) => prLines(item) !== null && item.changedFiles !== undefined)
    .sort((a, b) => prLines(b)! - prLines(a)! || a.url.localeCompare(b.url));
  const buckets = sizeBuckets.map(({ id, label }) => ({ id, label, items: sized.filter((item) => sizeBucket(prLines(item)!) === id) }));
  const large = buckets.filter(({ id }) => id === "L" || id === "XL").reduce((sum, { items: group }) => sum + group.length, 0);
  return { total: prs.length, known: sized.length, medianLines: median(sized.map((item) => prLines(item)!)),
    medianFiles: median(sized.map((item) => item.changedFiles!)), lines: sized.reduce((sum, item) => sum + prLines(item)!, 0),
    buckets, largeShare: sized.length ? large / sized.length : null };
}
export function mergedPrs(events: Event[]): Event[] {
  return distinct(events.filter((event) => event.metric === "merged"));
}

export type ReviewLoad = { prs: number; known: number; lines: number; files: number };
/** Lines and files across the distinct PRs each contributor reviewed; each PR counts once per reviewer. */
export function reviewLoad(events: Event[]): Map<string, ReviewLoad> {
  const reviewed = new Map<string, Event>();
  for (const event of events) if (event.metric === "reviewed") reviewed.set(`${event.login}\0${event.url}`, event);
  const loads = new Map<string, ReviewLoad>();
  for (const event of reviewed.values()) {
    const load = loads.get(event.login) ?? { prs: 0, known: 0, lines: 0, files: 0 };
    load.prs++;
    const lines = prLines(event);
    if (lines !== null && event.changedFiles !== undefined) {
      load.known++;
      load.lines += lines;
      load.files += event.changedFiles;
    }
    loads.set(event.login, load);
  }
  return loads;
}
