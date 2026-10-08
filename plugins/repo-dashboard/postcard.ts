import { dailyCounts, flowScore, weekBounds } from "./activity.js";
import { type Event, type InProgress } from "./contract.js";

export type PostcardInput = {
  orgLabel: string;
  week: string;
  fetchedAt: string;
  current: boolean;
  events: Event[];
  previousEvents?: Event[];
  inProgress: number;
  previousInProgress?: number;
  inProgressItems?: InProgress[];
  previousInProgressItems?: InProgress[];
  flowBaselineItems?: InProgress[];
};

export function averageFlow(events: Event[], current: InProgress[], previous?: InProgress[]): { value?: number; contributors: number } {
  const groups = new Map<string, Event[]>();
  for (const event of events) {
    const login = event.login.toLowerCase();
    const group = groups.get(login) ?? [];
    group.push(event);
    groups.set(login, group);
  }
  const contributors = groups.size;
  if (!contributors || previous === undefined) return { contributors };
  const countByLogin = (items: InProgress[]) => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const login = item.login.toLowerCase();
      counts.set(login, (counts.get(login) ?? 0) + 1);
    }
    return counts;
  };
  const now = countByLogin(current);
  const before = countByLogin(previous);
  let sum = 0;
  for (const [login, group] of groups) {
    const distinct = new Map<string, Event>();
    for (const event of group) distinct.set(`${event.metric}\0${event.url}`, event);
    sum += flowScore([...distinct.values()], now.get(login) ?? 0, before.get(login) ?? 0);
  }
  return { value: sum / contributors, contributors };
}

function xml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function short(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function dateLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })
    .format(new Date(`${date}T12:00:00Z`));
}

function previousWeek(week: string): string {
  const date = new Date(`${week}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 7);
  return date.toISOString().slice(0, 10);
}

const etClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

function etWallTime(at: string): string {
  const parts = Object.fromEntries(etClock.formatToParts(new Date(at)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function elapsedWeekDays(week: string, fetchedAt: string): number {
  return Math.min(7, Math.max(0, (Date.parse(`${etWallTime(fetchedAt)}Z`) - Date.parse(`${week}T00:00:00Z`)) / 86_400_000));
}

function previousWallTime(at: string): string {
  const wall = etWallTime(at);
  return `${previousWeek(wall.slice(0, 10))}${wall.slice(10)}`;
}

function scoped(events: Event[], week: string, cutoff?: (event: Event) => boolean): Event[] {
  const { start, end } = weekBounds(week);
  const first = Date.parse(start);
  const last = Date.parse(end);
  const distinct = new Map<string, Event>();
  for (const event of events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < first || at >= last || (cutoff && !cutoff(event))) continue;
    const key = `${event.metric}\0${event.login.toLowerCase()}\0${event.url}`;
    const previous = distinct.get(key);
    if (!previous || at > Date.parse(previous.at)) distinct.set(key, event);
  }
  return [...distinct.values()];
}

function priorReviews(events: Event[], week: string, cutoff: string): { count?: number; incomplete: boolean } {
  const { start, end } = weekBounds(week);
  const first = Date.parse(start);
  const last = Date.parse(end);
  const pairs = new Map<string, { earliest: string; hasFirstReviewedAt: boolean }>();
  for (const event of events) {
    if (event.metric !== "reviewed") continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < first || at >= last) continue;
    const key = `${event.login.toLowerCase()}\0${event.url}`;
    const validFirst = event.firstReviewedAt && Date.parse(event.firstReviewedAt) >= first && Date.parse(event.firstReviewedAt) < last;
    const earliest = validFirst && Date.parse(event.firstReviewedAt!) < at ? event.firstReviewedAt! : event.at;
    const found = pairs.get(key);
    if (found) {
      if (Date.parse(earliest) < Date.parse(found.earliest)) found.earliest = earliest;
      found.hasFirstReviewedAt ||= !!validFirst;
    } else pairs.set(key, { earliest, hasFirstReviewedAt: !!validFirst });
  }
  let count = 0;
  let incomplete = false;
  for (const pair of pairs.values()) {
    if (etWallTime(pair.earliest) <= cutoff) count++;
    else if (!pair.hasFirstReviewedAt) incomplete = true;
  }
  return { count: incomplete ? undefined : count, incomplete };
}

export function postcardCounts(input: PostcardInput): { currentEvents: Event[]; priorEvents?: Event[]; previousReviewed?: number; previousReviewsIncomplete: boolean } {
  const bounds = weekBounds(input.week);
  const fetched = Date.parse(input.fetchedAt);
  const currentCutoff = input.current ? Math.min(Math.max(fetched, Date.parse(bounds.start)), Date.parse(bounds.end)) : undefined;
  const currentEvents = scoped(input.events, input.week, currentCutoff === undefined ? undefined : (event) => Date.parse(event.at) <= currentCutoff);
  if (input.previousEvents === undefined) return { currentEvents, previousReviewsIncomplete: false };
  const priorWeek = previousWeek(input.week);
  const priorCutoff = currentCutoff === undefined ? undefined : previousWallTime(new Date(currentCutoff).toISOString());
  const priorEvents = scoped(input.previousEvents, priorWeek, priorCutoff === undefined ? undefined : (event) => etWallTime(event.at) <= priorCutoff);
  const reviews = priorCutoff === undefined ? { count: priorEvents.filter((event) => event.metric === "reviewed").length, incomplete: false }
    : priorReviews(input.previousEvents, priorWeek, priorCutoff);
  return { currentEvents, priorEvents, previousReviewed: reviews.count, previousReviewsIncomplete: reviews.incomplete };
}

export function postcardSvg(input: PostcardInput): string {
  const { currentEvents, priorEvents, previousReviewed } = postcardCounts(input);
  const selectedFlow = averageFlow(currentEvents, input.inProgressItems ?? [], input.previousInProgressItems);
  const fullPriorEvents = input.previousEvents === undefined ? undefined : scoped(input.previousEvents, previousWeek(input.week));
  const priorFlow = fullPriorEvents === undefined || input.previousInProgressItems === undefined
    ? undefined : averageFlow(fullPriorEvents, input.previousInProgressItems, input.flowBaselineItems);
  const selectedDays = input.current ? elapsedWeekDays(input.week, input.fetchedAt) : 7;
  const dayLabel = selectedDays > 0 && selectedDays < 0.05 ? "<0.1 day" : `${selectedDays.toFixed(1)} days`;
  const selectedRate = selectedDays > 0 && selectedFlow.value !== undefined ? selectedFlow.value / selectedDays : undefined;
  const priorRate = priorFlow?.value === undefined ? undefined : priorFlow.value / 7;
  const flowText = (value?: number) => value === undefined ? "—" : value.toFixed(1);
  const flowChange = selectedRate === undefined || priorRate === undefined ? "—"
    : `${Math.abs(selectedRate - priorRate) < 0.05 ? "+" : selectedRate > priorRate ? "+" : ""}${(Math.abs(selectedRate - priorRate) < 0.05 ? 0 : selectedRate - priorRate).toFixed(1)}`;
  const knownRates = [selectedRate, priorRate].filter((rate): rate is number => rate !== undefined);
  const rateMin = Math.min(0, ...knownRates);
  const rateSpan = Math.max(0, ...knownRates) - rateMin || 1;
  const rateX = (rate: number) => 246 + Math.round((rate - rateMin) / rateSpan * 72);
  const count = (events: Event[], metric: Event["metric"]) => events.filter((event) => event.metric === metric).length;
  const metrics = ([ ["opened", "Opened PRs"], ["merged", "Merged PRs"], ["reviewed", "Review contributions"] ] as const)
    .map(([metric, label]) => ({ label, current: count(currentEvents, metric), previous: metric === "reviewed" ? previousReviewed : priorEvents === undefined ? undefined : count(priorEvents, metric) }));
  const scale = Math.max(1, ...metrics.flatMap(({ current, previous }) => previous === undefined ? [current] : [current, previous]));
  const comparisons = metrics.map(({ label, current, previous }, index) => {
    const y = 166 + index * 42;
    const currentX = 246 + Math.round(current / scale * 72);
    const previousX = previous === undefined ? undefined : 246 + Math.round(previous / scale * 72);
    const change = previous === undefined ? "—" : `${current - previous >= 0 ? "+" : ""}${current - previous}`;
    return `<g>
<text x="40" y="${y}" class="metric">${label}</text>
<path d="M246 ${y - 5}H318" stroke="#e2e8f0"/>${previousX === undefined ? "" : `<path d="M${currentX} ${y - 9}L${previousX} ${y - 1}" stroke="#cbd5e1"/>`}
<circle cx="${currentX}" cy="${y - 9}" r="3.5" fill="#2563eb"/>${previousX === undefined ? "" : `<circle cx="${previousX}" cy="${y - 1}" r="3.5" fill="#94a3b8"/>`}
<text x="438" y="${y}" text-anchor="end" class="value current">${current}</text>
<text x="536" y="${y}" text-anchor="end" class="value prior">${previous ?? "—"}</text>
<text x="672" y="${y}" text-anchor="end" class="value change">${change}</text>
</g>`;
  }).join("");
  const counts = dailyCounts(currentEvents, input.week);
  const dailyMax = Math.max(1, ...counts);
  const dailyBars = counts.map((value, index) => {
    const height = value ? Math.max(3, Math.round(value / dailyMax * 28)) : 2;
    const x = 54 + index * 45;
    return `<rect x="${x}" y="${412 - height}" width="8" height="${height}" rx="2" fill="${value ? "#2563eb" : "#cbd5e1"}"/><text x="${x + 4}" y="429" text-anchor="middle" class="tiny">${["M", "T", "W", "T", "F", "S", "S"][index]}</text>`;
  }).join("");
  const { endDate } = weekBounds(input.week);
  const lastDay = new Date(`${endDate}T12:00:00Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  const endLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(lastDay);
  const fetched = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(input.fetchedAt));
  const delta = input.previousInProgress === undefined ? "" : `${input.inProgress - input.previousInProgress >= 0 ? "+" : ""}${input.inProgress - input.previousInProgress} since prior week-end snapshot`;
  const title = input.current ? "Week so far" : "Week of";
  const comparison = input.current ? "Week to date vs same point last week" : "Complete week vs prior complete week";
  const through = input.current ? ` · Through ${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(input.fetchedAt))} ET` : "";
  const inProgressQualifier = input.current ? "fetch-time snapshot" : "week-end snapshot";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="505" viewBox="0 0 720 505" role="img" aria-label="${xml(short(input.orgLabel, 40))} GitHub weekly activity postcard">
<style>text{font-family:Arial,sans-serif;font-variant-numeric:tabular-nums}.title{font-size:24px;font-weight:700;fill:#17243b}.sub{font-size:12px;fill:#53627a}.section{font-size:12px;font-weight:600;fill:#334155}.head{font-size:11px;fill:#64748b}.metric{font-size:13px;fill:#334155}.value{font-size:16px;font-weight:600;fill:#17243b}.current{fill:#1d4ed8}.prior{fill:#64748b}.change{fill:#334155}.snapshot{font-size:22px;font-weight:700;fill:#17243b}.tiny{font-size:10px;fill:#64748b}.footer{font-size:11px;fill:#64748b}</style>
<rect width="720" height="505" rx="12" fill="#f8fbff"/><rect x="1" y="1" width="718" height="503" rx="11" fill="none" stroke="#cbd5e1"/>
<text x="40" y="44" class="title">${xml(short(input.orgLabel, 36))}</text>
<text x="40" y="65" class="sub">${title} ${xml(dateLabel(input.week))}–${xml(endLabel)} (ET)</text>
<text x="40" y="88" class="section">${comparison}${xml(through)}</text>
<path d="M40 104H680" stroke="#cbd5e1"/>
<text x="40" y="130" class="head">Metric</text>
<text x="246" y="130" class="head">Shared scale</text>
<text x="438" y="130" text-anchor="end" class="head current">${input.current ? "This week" : "Selected"}</text>
<text x="536" y="130" text-anchor="end" class="head prior">${input.current ? "Last week" : "Prior"}</text>
<text x="672" y="130" text-anchor="end" class="head">Change</text>
${comparisons}
<path d="M40 276H680" stroke="#e2e8f0"/>
<text x="40" y="302" class="metric">Average daily Flow</text>
<text x="246" y="286" class="tiny">Rate scale</text>
<path d="M246 297H318" stroke="#e2e8f0"/>${selectedRate === undefined || priorRate === undefined ? "" : `<path d="M${rateX(selectedRate)} 293L${rateX(priorRate)} 301" stroke="#cbd5e1"/>`}
${selectedRate === undefined ? "" : `<circle cx="${rateX(selectedRate)}" cy="293" r="3.5" fill="#2563eb"/>`}${priorRate === undefined ? "" : `<circle cx="${rateX(priorRate)}" cy="301" r="3.5" fill="#94a3b8"/>`}
<text x="438" y="302" text-anchor="end" class="value current">${flowText(selectedRate)}</text>
<text x="536" y="302" text-anchor="end" class="value prior">${flowText(priorRate)}</text>
<text x="672" y="302" text-anchor="end" class="value change">${flowChange}</text>
<text x="40" y="321" class="head">Per active contributor · ${selectedFlow.contributors} selected / ${priorFlow?.contributors ?? "—"} prior · ${xml(dayLabel)} elapsed vs prior full 7 days${priorFlow && input.flowBaselineItems === undefined ? " · Flow baseline unavailable" : ""}</text>
<path d="M40 336H680" stroke="#cbd5e1"/>
<text x="40" y="360" class="section">Daily activity · Mon–Sun</text>
<path d="M40 412H350" stroke="#cbd5e1"/>${dailyBars}
<text x="436" y="360" class="section">PRs in progress</text>
<text x="436" y="393" class="snapshot">${input.inProgress}</text>
<text x="436" y="412" class="head">90-day ${inProgressQualifier}</text>${delta ? `
<text x="436" y="429" class="head">${xml(delta)}</text>` : ""}
<path d="M40 446H680" stroke="#cbd5e1"/>
<text x="40" y="466" class="footer">Fetched ${xml(fetched)}</text>
<text x="40" y="484" class="footer">${metrics.some(({ previous }) => previous === undefined) ? "— unavailable · " : ""}Reviews = distinct contributor–PR pairs; Flow averages contributors with PR activity.</text>
</svg>`;
}

export function postcardFilename(orgLabel: string, week: string): string {
  const org = orgLabel.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48) || "organization";
  return `${org}-${week}-week-postcard.svg`;
}
