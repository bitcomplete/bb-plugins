import { weekBounds } from "./activity.js";
import { type Event } from "./contract.js";

export type ReviewConnectionsData = {
  reviewers: string[];
  authors: string[];
  cells: Map<string, number>;
  max: number;
  known: number;
  total: number;
};

export function connectionKey(reviewer: string, author: string): string {
  return `${reviewer}\0${author}`;
}

export function reviewConnections(events: Event[], week: string): ReviewConnectionsData {
  const { start, end } = weekBounds(week);
  const first = Date.parse(start);
  const last = Date.parse(end);
  const contributions = new Map<string, Event>();
  for (const event of events) {
    if (event.metric !== "reviewed") continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < first || at >= last) continue;
    const key = `${event.login.toLowerCase()}\0${event.url}`;
    const previous = contributions.get(key);
    if (!previous || (!previous.authorLogin && event.authorLogin) ||
      (!!previous.authorLogin === !!event.authorLogin && at > Date.parse(previous.at))) contributions.set(key, event);
  }

  const cells = new Map<string, number>();
  const reviewerTotals = new Map<string, number>();
  const authorTotals = new Map<string, number>();
  let known = 0;
  for (const event of contributions.values()) {
    if (!event.authorLogin) continue;
    known++;
    const reviewer = event.login.toLowerCase();
    const author = event.authorLogin.toLowerCase();
    if (reviewer === author) continue;
    const key = connectionKey(reviewer, author);
    cells.set(key, (cells.get(key) ?? 0) + 1);
    reviewerTotals.set(reviewer, (reviewerTotals.get(reviewer) ?? 0) + 1);
    authorTotals.set(author, (authorTotals.get(author) ?? 0) + 1);
  }
  const ordered = (totals: Map<string, number>) => [...totals.keys()].sort((a, b) =>
    totals.get(b)! - totals.get(a)! || a.localeCompare(b));
  return { reviewers: ordered(reviewerTotals), authors: ordered(authorTotals), cells,
    max: Math.max(0, ...cells.values()), known, total: contributions.size };
}
