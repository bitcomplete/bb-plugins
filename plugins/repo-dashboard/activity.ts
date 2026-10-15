import { z } from "zod";
import { type Event, type InProgress } from "./contract.js";

export type Metric = Event["metric"];
export const metrics = ["opened", "merged", "reviewed", "closed"] as const;
const login = z.object({ login: z.string().min(1).max(100), __typename: z.string().optional() }).nullable();
const review = z.object({ id: z.string().max(300), submittedAt: z.string().nullable(), state: z.string(), author: login });
const pr = z.object({
  __typename: z.literal("PullRequest"), number: z.number().int().positive(), title: z.string().max(300),
  url: z.string().url().max(500), createdAt: z.string(), mergedAt: z.string().nullable(), closedAt: z.string().nullable(),
  author: login, repository: z.object({ nameWithOwner: z.string().max(200) }),
  additions: z.number().int().nonnegative().optional(), deletions: z.number().int().nonnegative().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
  reviews: z.object({ nodes: z.array(review), pageInfo: z.object({ hasNextPage: z.boolean() }) }),
});
export const searchResponse = z.object({
  data: z.object({ search: z.object({ issueCount: z.number().int().nonnegative(),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    nodes: z.array(z.unknown()),
  }) }),
  errors: z.array(z.object({ message: z.string() })).optional(),
});
export type Search = z.infer<typeof searchResponse>["data"]["search"];
const IN_PROGRESS_WINDOW_MS = 90 * 86400000;
const snapshotPr = pr.omit({ reviews: true }).extend({ isDraft: z.boolean() });

function boundedTitles(search: Search): Search {
  return { ...search, nodes: search.nodes.map((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const item = raw as Record<string, unknown>;
    if (item.__typename !== "PullRequest" || typeof item.title !== "string" || item.title.length <= 300) return raw;
    return { ...item, title: `${item.title.slice(0, 299)}…` };
  }) };
}

const etParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });

export function etDate(instant: Date): string {
  if (!Number.isFinite(instant.getTime())) throw new Error("Invalid date");
  const parts = Object.fromEntries(etParts.formatToParts(instant).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function etMidnight(date: string): Date {
  const guess = new Date(`${date}T00:00:00.000Z`);
  const parts = Object.fromEntries(etParts.formatToParts(guess).map(({ type, value }) => [type, value]));
  const localAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour));
  return new Date(guess.getTime() + guess.getTime() - localAsUtc);
}
export function mondayEt(instant: Date): string {
  const date = etDate(instant);
  const midnight = new Date(`${date}T00:00:00.000Z`);
  midnight.setUTCDate(midnight.getUTCDate() - ((midnight.getUTCDay() + 6) % 7));
  return midnight.toISOString().slice(0, 10);
}
export function weekBounds(week: string): { start: string; end: string; endDate: string } {
  const date = new Date(`${week}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(week) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== week || date.getUTCDay() !== 1) throw new Error("Choose a Monday in Eastern Time.");
  const endDate = new Date(date.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  return { start: etMidnight(week).toISOString(), end: etMidnight(endDate).toISOString(), endDate };
}
export function dailyCounts(events: Event[], week: string): number[] {
  const counts = Array.from({ length: 7 }, () => 0);
  for (const event of events) {
    const date = etDate(new Date(event.at));
    const day = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${week}T00:00:00Z`)) / 86400000);
    if (day >= 0 && day < 7) counts[day]++;
  }
  return counts;
}
export function eventsOnEtDay(events: Event[], week: string, day: number): Event[] {
  const date = new Date(`${week}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + day);
  const selected = date.toISOString().slice(0, 10);
  return events.filter((event) => etDate(new Date(event.at)) === selected);
}
export function inProgressAgeDays(item: InProgress, week: string, fetchedAt: string, current: boolean): number {
  const cutoff = current ? Date.parse(fetchedAt) : Date.parse(weekBounds(week).end);
  return Math.max(0, Math.floor((cutoff - Date.parse(item.createdAt)) / 86400000));
}
export function weekNote(events: Event[], week: string, current: boolean, inProgress: number, previous?: number): string {
  const counts = dailyCounts(events, week);
  const peak = Math.max(...counts);
  const peakDays = counts.filter((count) => count === peak).length;
  const lead = peak === 0 ? current ? "No PR activity yet this week" : "No PR activity this week"
    : `${current ? "So far this week, activity" : "Activity"} peaked ${peakDays === 1 ? `on ${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][counts.indexOf(peak)]}` : `on ${peakDays} days`} (${peak} ${peak === 1 ? "event" : "events"}${peakDays > 1 ? " each" : ""})`;
  const status = previous === undefined ? `${inProgress} ${inProgress === 1 ? "PR" : "PRs"} in progress`
    : inProgress === previous ? "in-progress held steady"
      : `in-progress ${inProgress > previous ? "rose" : "fell"} by ${Math.abs(inProgress - previous)}`;
  return `${lead}; ${status}.`;
}
export function flowScore(events: Event[], currentInProgress: number, previousInProgress: number): number {
  const count = (metric: Metric) => events.filter((event) => event.metric === metric).length;
  return count("opened") + 2 * count("merged") + 0.5 * count("reviewed")
    - 0.25 * Math.max(0, currentInProgress - previousInProgress);
}
export function inProgressChange(current: number, previous: number): { delta: number; percent: number | null } {
  return { delta: current - previous, percent: previous === 0 ? null : (current - previous) / previous * 100 };
}
function size(item: { additions?: number; deletions?: number; changedFiles?: number }) {
  return item.additions === undefined || item.deletions === undefined || item.changedFiles === undefined ? {}
    : { additions: item.additions, deletions: item.deletions, changedFiles: item.changedFiles };
}
function human(author: z.infer<typeof login>): string | null {
  if (!author || author.__typename === "Bot" || /\[bot\]$/iu.test(author.login) || author.login.toLowerCase() === "parsleybot") return null;
  return author.login;
}
export function eventsFromSearch(search: Search, metric: Metric, week: string): Event[] {
  const { start, end } = weekBounds(week);
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const within = (at: string | null): at is string => {
    if (at === null) return false;
    const time = Date.parse(at);
    return Number.isFinite(time) && time >= startMs && time < endMs;
  };
  const events: Event[] = [];
  for (const raw of search.nodes) {
    if (raw === null || (typeof raw === "object" && (raw as { __typename?: unknown }).__typename !== "PullRequest")) continue;
    const item = pr.parse(raw);
    if (metric === "reviewed") {
      if (item.reviews.pageInfo.hasNextPage) throw new Error(`Review history exceeds 100 entries on ${item.url}; weekly data is incomplete.`);
      const authorLogin = human(item.author);
      for (const one of item.reviews.nodes) {
        const reviewer = human(one.author);
        if (!reviewer || !within(one.submittedAt) || one.state === "PENDING") continue;
        events.push({ id: `review:${reviewer}:${item.url}`, metric, login: reviewer, repo: item.repository.nameWithOwner,
          number: item.number, title: item.title, url: item.url, at: one.submittedAt, firstReviewedAt: one.submittedAt,
          ...(authorLogin ? { authorLogin } : {}), ...size(item) });
      }
      continue;
    }
    const author = human(item.author);
    const at = metric === "opened" ? item.createdAt : metric === "merged" ? item.mergedAt : item.mergedAt === null ? item.closedAt : null;
    if (!author || !within(at)) continue;
    events.push({ id: `${metric}:${item.url}`, metric, login: author, repo: item.repository.nameWithOwner,
      number: item.number, title: item.title, url: item.url, at, ...size(item) });
  }
  return events;
}
export function uniqueEvents(events: Event[]): Event[] {
  const latest = new Map<string, Event>();
  for (const event of events) {
    const previous = latest.get(event.id);
    if (!previous) { latest.set(event.id, event); continue; }
    const newest = event.at > previous.at ? event : previous;
    if (event.metric === "reviewed" && previous.metric === "reviewed") {
      const first = event.firstReviewedAt ?? event.at;
      const priorFirst = previous.firstReviewedAt ?? previous.at;
      latest.set(event.id, { ...newest, firstReviewedAt: Date.parse(first) < Date.parse(priorFirst) ? first : priorFirst });
    } else {
      latest.set(event.id, newest);
    }
  }
  return [...latest.values()]
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}
export function searchQuery(org: string, metric: Metric, week: string): string {
  const { endDate } = weekBounds(week);
  const qualifier = metric === "opened" ? "created" : metric === "merged" ? "merged" : metric === "closed" ? "closed" : "updated";
  return `org:${org} is:pr ${qualifier}:${week}..${endDate}`;
}

export function inProgressQueries(org: string, week: string, now: Date): string[] {
  const { endDate } = weekBounds(week);
  const current = mondayEt(now) === week;
  const cutoff = current ? now : new Date(weekBounds(week).end);
  const createdAfter = new Date(cutoff.getTime() - IN_PROGRESS_WINDOW_MS).toISOString().slice(0, 10);
  const created = current ? `created:>=${createdAfter}` : `created:${createdAfter}..${endDate}`;
  const open = `org:${org} is:pr is:open ${created}`;
  if (current) return [open];
  return [open, `org:${org} is:pr is:closed closed:>=${endDate} ${created}`];
}

export function inProgressFromSearch(search: Search, cutoff: Date, openNow = false): InProgress[] {
  const cutoffMs = cutoff.getTime();
  const createdAfterMs = cutoffMs - IN_PROGRESS_WINDOW_MS;
  return search.nodes.flatMap((raw) => {
    if (raw === null || (typeof raw === "object" && (raw as { __typename?: unknown }).__typename !== "PullRequest")) return [];
    const item = snapshotPr.parse(raw);
    const author = human(item.author);
    const createdAtMs = Date.parse(item.createdAt);
    if (!author || !Number.isFinite(createdAtMs) || createdAtMs < createdAfterMs || createdAtMs >= cutoffMs ||
        (!openNow && item.closedAt !== null && !(Date.parse(item.closedAt) >= cutoffMs))) return [];
    return [{ login: author, repo: item.repository.nameWithOwner, number: item.number,
      title: item.title, url: item.url, createdAt: item.createdAt, isDraft: item.isDraft, ...size(item) }];
  });
}

async function completeSearch(query: string, label: string,
  run: (query: string, cursor: string | null, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal,
): Promise<Search[]> {
  const pages: Search[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const raw = searchResponse.parse(await run(query, cursor, signal));
    if (raw.errors?.length) throw new Error(`GitHub search failed: ${raw.errors[0].message.slice(0, 300)}`);
    const search = boundedTitles(raw.data.search);
    if (search.issueCount > 1000) throw new Error(`${label} search has ${search.issueCount} matches. GitHub exposes only 1,000; weekly data is incomplete.`);
    pages.push(search);
    if (!search.pageInfo.hasNextPage) return pages;
    const next = search.pageInfo.endCursor;
    if (!next || seen.has(next)) throw new Error(`GitHub ${label} pagination stopped before all results loaded.`);
    seen.add(next);
    cursor = next;
  }
  throw new Error(`GitHub ${label} search exceeded 10 pages; weekly data is incomplete.`);
}

export async function loadInProgress(
  org: "parsleyhealth" | "bitcomplete" | "ira-cscc", week: string, now: Date,
  run: (query: string, cursor: string | null, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal,
): Promise<InProgress[]> {
  const { end } = weekBounds(week);
  const currentWeek = mondayEt(now);
  if (week > currentWeek) throw new Error("Choose the current week or an earlier Monday in Eastern Time.");
  const openNow = currentWeek === week;
  const cutoff = openNow ? now : new Date(end);
  const results = new Map<string, InProgress>();
  const searches = await Promise.all(inProgressQueries(org, week, now).map((query) => completeSearch(query, "in-progress", run, signal)));
  for (const pages of searches) {
    for (const search of pages) {
      for (const item of inProgressFromSearch(search, cutoff, openNow)) results.set(item.url, item);
    }
  }
  return [...results.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.url.localeCompare(b.url));
}

export async function loadActivity(
  org: "parsleyhealth" | "bitcomplete" | "ira-cscc", week: string,
  run: (query: string, cursor: string | null, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal,
): Promise<Event[]> {
  weekBounds(week);
  const searches = await Promise.all(metrics.map((metric) => completeSearch(searchQuery(org, metric, week), metric, run, signal)));
  const all: Event[] = [];
  for (const [index, metric] of metrics.entries()) {
    for (const search of searches[index]!) {
      all.push(...eventsFromSearch(search, metric, week));
    }
  }
  return uniqueEvents(all);
}
