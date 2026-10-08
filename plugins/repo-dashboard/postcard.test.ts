import { describe, expect, it } from "vitest";
import { type Event, type InProgress } from "./contract.js";
import { averageFlow, elapsedWeekDays, postcardCounts, postcardFilename, postcardSvg, type PostcardInput } from "./postcard.js";

const base: PostcardInput = { orgLabel: "Bit Complete", week: "2026-09-28", fetchedAt: "2026-10-02T16:00:00Z", current: true, events: [], inProgress: 4 };
function event(metric: Event["metric"], login: string, number: number, at = "2026-09-29T12:00:00Z"): Event {
  return { id: `${metric}:${login}:${number}`, metric, login, repo: "bitcomplete/app", number, title: "Change",
    url: `https://github.com/bitcomplete/app/pull/${number}`, at };
}
function item(login: string, number: number): InProgress {
  return { login, repo: "bitcomplete/app", number, title: "Change", url: `https://github.com/bitcomplete/app/pull/${number}`, createdAt: "2026-09-01T12:00:00Z", isDraft: false };
}
describe("week postcard", () => {
  it("averages active contributors using each person's Flow penalty, even when another backlog shrinks", () => {
    const result = averageFlow([event("opened", "Alice", 1), event("closed", "BOB", 2)],
      [item("alice", 3), item("ALICE", 4)], [item("Bob", 5), item("bob", 6)]);
    expect(result).toEqual({ value: 0.25, contributors: 2 });
  });
  it("counts a repeated review once and folds login case within the active cohort", () => {
    const result = averageFlow([event("reviewed", "Alice", 1), event("reviewed", "alice", 1), event("opened", "ALICE", 2)], [], []);
    expect(result).toEqual({ value: 1.5, contributors: 1 });
  });
  it("keeps empty weeks and missing snapshots unknown rather than displaying a numeric average", () => {
    expect(averageFlow([], [item("backlog-only", 1)], [])).toEqual({ contributors: 0 });
    expect(averageFlow([event("opened", "alice", 1)], [], undefined)).toEqual({ contributors: 1 });
    expect(averageFlow([event("opened", "alice", 1)], [item("backlog-only", 2), item("another", 3)], [])).toEqual({ value: 1, contributors: 1 });
  });
  it("compares current Flow per elapsed ET day with full prior-week Flow per seven days", () => {
    const svg = postcardSvg({ ...base, events: [event("opened", "alice", 1)], previousEvents: [event("opened", "bob", 2, "2026-09-22T12:00:00Z"), event("opened", "bob", 3, "2026-09-27T12:00:00Z")],
      inProgressItems: [], previousInProgressItems: [], flowBaselineItems: [] });
    expect(svg).toContain("Average daily Flow");
    expect(svg).toContain("Per active contributor · 1 selected / 1 prior · 4.5 days elapsed vs prior full 7 days");
    expect(svg).toContain('>0.2</text>');
    expect(svg).toContain('>0.3</text>');
    expect(svg).toContain('>-0.1</text>');
  });
  it("places signed Flow rates on their own scale with both period marks", () => {
    const svg = postcardSvg({ ...base, events: [event("opened", "alice", 1)],
      previousEvents: [event("opened", "bob", 2, "2026-09-22T12:00:00Z")],
      inProgressItems: Array.from({ length: 8 }, (_, index) => item("alice", index + 10)),
      previousInProgressItems: [], flowBaselineItems: [] });
    expect(svg).toContain('<text x="246" y="286" class="tiny">Rate scale</text>');
    expect(svg).toContain('<path d="M246 293L318 301" stroke="#cbd5e1"/>');
    expect(svg).toContain('<circle cx="246" cy="293" r="3.5" fill="#2563eb"/>');
    expect(svg).toContain('<circle cx="318" cy="301" r="3.5" fill="#94a3b8"/>');
  });
  it("omits unknown Flow marks while retaining a known period's mark", () => {
    const svg = postcardSvg({ ...base, previousEvents: [event("opened", "bob", 2, "2026-09-22T12:00:00Z")],
      previousInProgressItems: [], flowBaselineItems: [] });
    expect(svg).not.toContain('cy="293" r="3.5"');
    expect(svg).toContain('<circle cx="318" cy="301" r="3.5" fill="#94a3b8"/>');
    expect(svg).not.toContain(' 293L');
  });
  it("compares completed-week averages with each period's cohort and baseline", () => {
    const svg = postcardSvg({ ...base, current: false, events: [event("opened", "alice", 1), event("opened", "bob", 2)],
      previousEvents: [event("merged", "cara", 3, "2026-09-22T12:00:00Z")], inProgressItems: [], previousInProgressItems: [], flowBaselineItems: [] });
    expect(svg).toContain("Per active contributor · 2 selected / 1 prior · 7.0 days elapsed vs prior full 7 days");
    expect(svg).toContain('>0.1</text>');
    expect(svg).toContain('>0.3</text>');
    expect(svg).toContain('>-0.1</text>');
  });
  it("shows a missing completed-week Flow baseline as unavailable", () => {
    const svg = postcardSvg({ ...base, current: false, events: [event("opened", "alice", 1)],
      previousEvents: [event("opened", "bob", 2, "2026-09-22T12:00:00Z")], inProgressItems: [], previousInProgressItems: [] });
    expect(svg).toContain("Per active contributor · 1 selected / 1 prior · 7.0 days elapsed vs prior full 7 days · Flow baseline unavailable");
    expect(svg).not.toContain(">+0.0</text>");
  });
  it("normalizes a tiny negative average change to positive zero after rounding", () => {
    const logins = Array.from({ length: 10 }, (_, index) => `person${index}`);
    const svg = postcardSvg({ ...base, current: false,
      events: logins.map((login, index) => event("opened", login, index + 1)),
      previousEvents: logins.map((login, index) => event("opened", login, index + 11, "2026-09-22T12:00:00Z")),
      inProgressItems: [item("person0", 30)], previousInProgressItems: [], flowBaselineItems: [] });
    expect(svg).toContain(">+0.0</text>");
    expect(svg).not.toContain(">-0.0</text>");
  });
  it("uses ET wall-clock days across daylight saving changes and leaves Monday midnight unknown", () => {
    expect(elapsedWeekDays("2026-03-09", "2026-03-09T04:00:00Z")).toBe(0);
    expect(elapsedWeekDays("2026-03-09", "2026-03-13T16:00:00Z")).toBe(4.5);
    expect(elapsedWeekDays("2026-03-02", "2026-03-08T16:00:00Z")).toBe(6.5);
    expect(elapsedWeekDays("2026-10-26", "2026-11-01T17:00:00Z")).toBe(6.5);
    const svg = postcardSvg({ ...base, week: "2026-09-28", fetchedAt: "2026-09-28T04:00:00Z",
      events: [event("opened", "alice", 1, "2026-09-28T04:00:00Z")],
      previousEvents: [event("opened", "bob", 2, "2026-09-22T12:00:00Z")],
      inProgressItems: [], previousInProgressItems: [], flowBaselineItems: [] });
    expect(svg).not.toContain("Infinity");
    expect(svg).not.toContain("NaN");
    expect(svg).toContain('<text x="438" y="302" text-anchor="end" class="value current">—</text>');
    expect(svg).not.toContain('cy="293" r="3.5"');
    expect(svg).toContain('<circle cx="318" cy="301" r="3.5" fill="#94a3b8"/>');
    const early = postcardSvg({ ...base, fetchedAt: "2026-09-28T04:01:00Z", inProgressItems: [], previousInProgressItems: [] });
    expect(early).toContain("&lt;0.1 day elapsed");
  });
  it("marks missing prior activity unavailable instead of treating it as zero", () => {
    const svg = postcardSvg({ ...base, events: [event("opened", "alice", 1)] });
    expect(svg).toContain("Week to date vs same point last week");
    expect(svg).toContain("— unavailable");
    expect(svg).not.toContain(">+1</text>");
  });
  it("deduplicates contributor–PR review pairs in each ET-scoped week", () => {
    const input = { ...base,
      events: [event("reviewed", "alice", 1), event("reviewed", "alice", 1, "2026-09-30T12:00:00Z"), event("reviewed", "bob", 1), event("opened", "alice", 2, "2026-09-28T03:59:59Z")],
      previousEvents: [event("reviewed", "alice", 1, "2026-09-22T12:00:00Z"), event("reviewed", "alice", 1, "2026-09-24T12:00:00Z"), event("reviewed", "bob", 2, "2026-09-21T03:59:59Z")],
    };
    const svg = postcardSvg(input);
    const counts = postcardCounts(input);
    expect(counts.currentEvents.filter((item) => item.metric === "reviewed")).toHaveLength(2);
    expect(counts.previousReviewed).toBe(1);
    expect(svg).toContain("Review contributions");
    expect(svg).toContain("Reviews = distinct contributor–PR pairs");
    expect(svg).toContain(">+1</text>");
  });
  it("compares a partial current week with the same ET weekday and time", () => {
    const svg = postcardSvg({ ...base, events: [event("opened", "alice", 1)], previousEvents: [
      event("opened", "alice", 2, "2026-09-21T12:00:00Z"), event("opened", "bob", 3, "2026-09-27T23:00:00Z"),
      event("opened", "cara", 4, "2026-09-25T16:00:01Z"),
    ] });
    expect(svg).toContain("Week to date vs same point last week · Through Fri 12:00 PM ET");
    expect(svg).toContain("Last week");
    expect(svg).toContain(">+0</text>");
  });
  it("uses cached fetchedAt for both cutoffs and excludes later events", () => {
    const counts = postcardCounts({ ...base, fetchedAt: "2026-09-29T15:18:00Z", events: [
      event("opened", "alice", 1, "2026-09-29T15:18:00Z"), event("opened", "bob", 2, "2026-09-29T15:18:01Z"),
    ], previousEvents: [
      event("opened", "alice", 3, "2026-09-22T15:18:00Z"), event("opened", "bob", 4, "2026-09-22T15:18:01Z"),
    ] });
    expect(counts.currentEvents).toHaveLength(1);
    expect(counts.priorEvents).toHaveLength(1);
  });
  it("filters before deduplicating repeated current-week reviews", () => {
    const counts = postcardCounts({ ...base, fetchedAt: "2026-09-29T15:18:00Z", events: [
      event("reviewed", "alice", 1, "2026-09-29T15:17:00Z"),
      event("reviewed", "Alice", 1, "2026-09-29T15:19:00Z"),
    ] });
    expect(counts.currentEvents).toHaveLength(1);
    expect(counts.currentEvents[0]?.at).toBe("2026-09-29T15:17:00Z");
  });
  it("keeps entire completed weeks regardless of fetchedAt", () => {
    const counts = postcardCounts({ ...base, current: false, fetchedAt: "2026-09-28T04:00:00Z",
      events: [event("opened", "alice", 1, "2026-10-04T23:00:00Z")],
      previousEvents: [event("merged", "bob", 2, "2026-09-27T23:00:00Z")],
    });
    expect(counts.currentEvents).toHaveLength(1);
    expect(counts.priorEvents).toHaveLength(1);
  });
  it("uses Eastern midnight as the calendar boundary", () => {
    const counts = postcardCounts({ ...base, fetchedAt: "2026-09-28T04:00:00Z", previousEvents: [
      event("opened", "alice", 1, "2026-09-21T04:00:00Z"), event("opened", "bob", 2, "2026-09-21T04:00:01Z"),
    ] });
    expect(counts.priorEvents).toHaveLength(1);
  });
  it.each([
    ["spring", "2026-03-09", "2026-03-13T19:18:00Z", "2026-03-06T20:18:00Z"],
    ["fall", "2026-11-02", "2026-11-06T20:18:00Z", "2026-10-30T19:18:00Z"],
  ])("compares %s weeks at the same Eastern wall time across DST", (_name, week, fetchedAt, at) => {
    const counts = postcardCounts({ ...base, week, fetchedAt, previousEvents: [
      event("opened", "alice", 1, at), event("opened", "bob", 2, new Date(Date.parse(at) + 1000).toISOString()),
    ] });
    expect(counts.priorEvents).toHaveLength(1);
  });
  it("counts an early review once even when its latest review follows the cutoff", () => {
    const earlier = event("reviewed", "Alice", 1, "2026-09-22T12:00:00Z");
    const later = event("reviewed", "alice", 1, "2026-09-27T12:00:00Z");
    expect(postcardCounts({ ...base, previousEvents: [earlier, later] }).previousReviewed).toBe(1);
    expect(postcardCounts({ ...base, previousEvents: [{ ...later, firstReviewedAt: earlier.at }] }).previousReviewed).toBe(1);
  });
  it("marks an old cached late review unknown until the previous week is refreshed", () => {
    const late = event("reviewed", "alice", 1, "2026-09-27T12:00:00Z");
    const counts = postcardCounts({ ...base, previousEvents: [late] });
    expect(counts.previousReviewsIncomplete).toBe(true);
    expect(counts.previousReviewed).toBeUndefined();
    const svg = postcardSvg({ ...base, previousEvents: [late] });
    expect(svg).toContain("— unavailable");
    expect(svg).toContain("Review contributions");
  });
  it("rejects review metadata from before the previous week", () => {
    const late = { ...event("reviewed", "alice", 1, "2026-09-27T12:00:00Z"), firstReviewedAt: "2026-09-14T12:00:00Z" };
    const counts = postcardCounts({ ...base, previousEvents: [late] });
    expect(counts.previousReviewsIncomplete).toBe(true);
    expect(counts.previousReviewed).toBeUndefined();
  });
  it("shows signed absolute differences when the prior count is zero", () => {
    const svg = postcardSvg({ ...base, current: false, events: [event("merged", "alice", 1)], previousEvents: [], previousInProgress: 6 });
    expect(svg).toContain("Complete week vs prior complete week");
    expect(svg).toContain(">+1</text>");
    expect(svg).toContain(">+0</text>");
    expect(svg).toContain("90-day week-end snapshot");
    expect(svg).toContain("-2 since prior week-end snapshot");
  });
  it("escapes arbitrary strings and truncates long organization names", () => {
    const orgLabel = `<script>"&'${"x".repeat(100)}`;
    const svg = postcardSvg({ ...base, orgLabel });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;&quot;&amp;&apos;");
    expect(svg).not.toContain("x".repeat(50));
    expect(postcardFilename(orgLabel, base.week)).toMatch(/^script-x{1,41}-2026-09-28-week-postcard\.svg$/u);
  });
  it("keeps seven daily stems alongside compact weekly comparison marks", () => {
    const svg = postcardSvg({ ...base, events: [event("opened", "alice", 1)], previousEvents: [] });
    expect(svg).toContain("Daily activity · Mon–Sun");
    expect((svg.match(/width="8" height="(?:2|3|28)" rx="2"/gu) ?? []).length).toBe(7);
    expect(svg).not.toContain('width="268"');
    expect(svg).not.toContain("NaN");
  });
});
