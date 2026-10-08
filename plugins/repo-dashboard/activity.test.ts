import { describe, expect, it } from "vitest";
import { dailyCounts, etDate, eventsFromSearch, eventsOnEtDay, flowScore, inProgressAgeDays, inProgressChange, inProgressFromSearch, inProgressQueries, loadActivity, loadInProgress, mondayEt, searchQuery, uniqueEvents, weekBounds, weekNote } from "./activity.js";
import { eventSchema } from "./contract.js";

const week = "2026-09-28";
function pr(overrides: Record<string, unknown> = {}) {
  return {
    __typename: "PullRequest", number: 42, title: "Improve eligibility", url: "https://github.com/parsleyhealth/sage/pull/42",
    createdAt: "2026-09-29T01:00:00Z", mergedAt: null, closedAt: null,
    author: { __typename: "User", login: "alice" }, repository: { nameWithOwner: "parsleyhealth/sage" },
    reviews: { pageInfo: { hasNextPage: false }, nodes: [] }, ...overrides,
  };
}
function search(nodes: unknown[], issueCount = nodes.length, hasNextPage = false, endCursor: string | null = null) {
  return { issueCount, nodes, pageInfo: { hasNextPage, endCursor } };
}
function response(value: ReturnType<typeof search>) { return { data: { search: value } }; }
function snapshot(overrides: Record<string, unknown> = {}) {
  const { reviews, ...item } = pr();
  return { ...item, isDraft: false, ...overrides };
}

describe("Eastern Time week boundaries", () => {
  it("starts at Monday midnight ET, including when UTC Monday is still ET Sunday", () => {
    expect(mondayEt(new Date("2026-10-05T03:59:59Z"))).toBe(week);
    expect(mondayEt(new Date("2026-10-05T04:00:00Z"))).toBe("2026-10-05");
    expect(weekBounds(week)).toEqual({ start: "2026-09-28T04:00:00.000Z", end: "2026-10-05T04:00:00.000Z", endDate: "2026-10-05" });
    expect(() => weekBounds("2026-09-29")).toThrow();
  });
  it("keeps Monday's first instant and excludes the instant before it and next Monday", () => {
    const items = [pr({ number: 3, url: "https://github.com/parsleyhealth/sage/pull/3", createdAt: "2026-09-28T03:59:59Z" }),
      pr({ number: 1, url: "https://github.com/parsleyhealth/sage/pull/1", createdAt: "2026-09-28T04:00:00Z" }),
      pr({ number: 2, url: "https://github.com/parsleyhealth/sage/pull/2", createdAt: "2026-10-05T04:00:00Z" })];
    expect(eventsFromSearch(search(items), "opened", week).map((event) => event.number)).toEqual([1]);
  });
  it("uses 167-hour spring weeks and 169-hour fall weeks", () => {
    expect(weekBounds("2026-03-02")).toEqual({ start: "2026-03-02T05:00:00.000Z", end: "2026-03-09T04:00:00.000Z", endDate: "2026-03-09" });
    expect(weekBounds("2026-10-26")).toEqual({ start: "2026-10-26T04:00:00.000Z", end: "2026-11-02T05:00:00.000Z", endDate: "2026-11-02" });
  });
  it("groups daily activity by ET calendar day across daylight saving changes", () => {
    const events = (times: string[]) => times.map((at, index) => ({ id: String(index), at })) as Parameters<typeof dailyCounts>[0];
    expect(dailyCounts(events(["2026-03-08T04:59:59Z", "2026-03-08T05:00:00Z", "2026-03-09T03:59:59Z", "2026-03-09T04:00:00Z"]), "2026-03-02")).toEqual([0, 0, 0, 0, 0, 1, 2]);
    expect(dailyCounts(events(["2026-11-01T03:59:59Z", "2026-11-01T05:00:00Z", "2026-11-01T06:00:00Z", "2026-11-02T04:59:59Z"]), "2026-10-26")).toEqual([0, 0, 0, 0, 0, 1, 3]);
    expect(etDate(new Date("2026-10-05T00:00:00Z"))).toBe("2026-10-04");
  });
  it("filters day details by ET date rather than UTC date", () => {
    const events = ["2026-09-29T03:59:59Z", "2026-09-29T04:00:00Z"].map((at, index) => ({ id: String(index), at })) as Parameters<typeof eventsOnEtDay>[0];
    expect(eventsOnEtDay(events, week, 0).map(({ id }) => id)).toEqual(["0"]);
    expect(eventsOnEtDay(events, week, 1).map(({ id }) => id)).toEqual(["1"]);
  });
});

describe("engagement details", () => {
  it("measures historical age at the selected ET week end and current age at fetch time", () => {
    const item = { createdAt: "2026-10-04T04:00:00Z" } as Parameters<typeof inProgressAgeDays>[0];
    expect(inProgressAgeDays(item, week, "2026-10-07T12:00:00Z", false)).toBe(1);
    const currentItem = { createdAt: "2026-10-06T12:00:00Z" } as Parameters<typeof inProgressAgeDays>[0];
    expect(inProgressAgeDays(currentItem, "2026-10-05", "2026-10-07T12:00:00Z", true)).toBe(1);
  });
  it("describes zero activity without inventing a peak or a backlog change", () => {
    expect(weekNote([], week, false, 0)).toBe("No PR activity this week; 0 PRs in progress.");
    expect(weekNote([], "2026-10-05", true, 1, 1)).toBe("No PR activity yet this week; in-progress held steady.");
  });
  it("labels a partial week and a tied peak without choosing a false winner", () => {
    const events = ["2026-10-05T12:00:00Z", "2026-10-06T12:00:00Z"].map((at, index) => ({ id: String(index), at })) as Parameters<typeof weekNote>[0];
    expect(weekNote(events, "2026-10-05", true, 3, 2)).toBe("So far this week, activity peaked on 2 days (1 event each); in-progress rose by 1.");
  });
});

describe("flow and in-progress change", () => {
  it("does not reward carried-over backlog or a shrinking backlog, and penalizes growth", () => {
    const events = ["opened", "merged", "reviewed", "reviewed", "closed"].map((metric) => ({ metric })) as Parameters<typeof flowScore>[0];
    expect(flowScore(events, 30, 30)).toBe(4);
    expect(flowScore(events, 25, 30)).toBe(4);
    expect(flowScore(events, 34, 30)).toBe(3);
  });
  it("reports an absolute change without inventing a percentage from zero", () => {
    expect(inProgressChange(4, 0)).toEqual({ delta: 4, percent: null });
    expect(inProgressChange(6, 4)).toEqual({ delta: 2, percent: 50 });
    expect(inProgressChange(2, 4)).toEqual({ delta: -2, percent: -50 });
  });
});

describe("event attribution", () => {
  it("retains human PR authors for review connections", () => {
    const item = pr({ mergedAt: "2026-09-30T12:00:00Z", author: { __typename: "User", login: "alice" },
      reviews: { pageInfo: { hasNextPage: false }, nodes: [
        { id: "r1", submittedAt: "2026-10-01T12:00:00Z", state: "COMMENTED", author: { __typename: "User", login: "bob" } },
      ] } });
    expect(eventsFromSearch(search([item]), "merged", week)[0]).not.toHaveProperty("authorLogin");
    expect(eventsFromSearch(search([item]), "reviewed", week)[0]).toMatchObject({ authorLogin: "alice" });
    const botAuthored = pr({ author: { __typename: "Bot", login: "helper[bot]" }, reviews: item.reviews });
    const reviewed = eventsFromSearch(search([botAuthored]), "reviewed", week)[0];
    expect(reviewed).not.toHaveProperty("authorLogin");
    expect(eventSchema.parse({ ...reviewed, createdAt: item.createdAt, firstReviewedAt: reviewed?.at })).toMatchObject({ createdAt: item.createdAt, firstReviewedAt: reviewed?.at });
  });
  it("credits authored opens, merges, and unmerged closes separately", () => {
    const item = pr({ mergedAt: "2026-09-30T12:00:00Z", closedAt: "2026-09-30T12:00:00Z" });
    expect(eventsFromSearch(search([item]), "opened", week)).toHaveLength(1);
    expect(eventsFromSearch(search([item]), "merged", week)).toHaveLength(1);
    expect(eventsFromSearch(search([item]), "closed", week)).toHaveLength(0);
  });
  it("excludes the Parsley automation account without excluding other user logins containing bot", () => {
    const automation = pr({ author: { __typename: "User", login: "ParsleyBot" } });
    const person = pr({ number: 43, url: "https://github.com/parsleyhealth/sage/pull/43",
      author: { __typename: "User", login: "robotics" } });
    expect(eventsFromSearch(search([automation, person]), "opened", week).map((event) => event.login)).toEqual(["robotics"]);
    const reviewed = pr({ reviews: { pageInfo: { hasNextPage: false }, nodes: [
      { id: "r1", submittedAt: "2026-09-29T10:00:00Z", state: "APPROVED", author: { __typename: "User", login: "parsleybot" } },
      { id: "r2", submittedAt: "2026-09-29T10:00:00Z", state: "APPROVED", author: { __typename: "User", login: "robotics" } },
    ] } });
    expect(eventsFromSearch(search([reviewed]), "reviewed", week).map((event) => event.login)).toEqual(["robotics"]);
    expect(inProgressFromSearch(search([snapshot({ author: { __typename: "User", login: "PARSLEYBOT" } })]), new Date("2026-10-05T00:00:00Z"))).toEqual([]);
  });
  it("counts each reviewer and older PR once, excluding repeated, bot, and pending reviews", () => {
    const older = pr({ createdAt: "2026-08-01T00:00:00Z", author: { __typename: "User", login: "bob" },
      reviews: { pageInfo: { hasNextPage: false }, nodes: [
        { id: "before", submittedAt: "2026-09-28T03:59:59Z", state: "COMMENTED", author: { __typename: "User", login: "alice" } },
        { id: "r1", submittedAt: "2026-09-29T10:00:00Z", state: "COMMENTED", author: { __typename: "User", login: "alice" } },
        { id: "r2", submittedAt: "2026-10-01T10:00:00Z", state: "APPROVED", author: { __typename: "User", login: "alice" } },
        { id: "r3", submittedAt: null, state: "PENDING", author: { __typename: "User", login: "alice" } },
        { id: "pending", submittedAt: "2026-09-28T04:00:00Z", state: "PENDING", author: { __typename: "User", login: "alice" } },
        { id: "r4", submittedAt: "2026-10-01T12:00:00Z", state: "COMMENTED", author: { __typename: "Bot", login: "helper[bot]" } },
        { id: "r5", submittedAt: "2026-10-02T12:00:00Z", state: "APPROVED", author: { __typename: "User", login: "carol" } },
        { id: "after", submittedAt: "2026-10-05T04:00:00Z", state: "APPROVED", author: { __typename: "User", login: "alice" } },
      ] } });
    const events = eventsFromSearch(search([older]), "reviewed", week);
    expect(events.map((event) => event.login)).toEqual(["alice", "alice", "carol"]);
    expect(events.map((event) => event.firstReviewedAt)).toEqual(events.map((event) => event.at));
    expect(uniqueEvents([...events, ...events]).map((event) => event.login)).toEqual(["carol", "alice"]);
    for (const input of [events, [...events].reverse()]) {
      expect(uniqueEvents(input).find((event) => event.login === "alice")).toMatchObject({
        at: "2026-10-01T10:00:00Z", firstReviewedAt: "2026-09-29T10:00:00Z", authorLogin: "bob",
      });
    }
    const legacyEvents = events.map(({ firstReviewedAt: _firstReviewedAt, ...event }) => event);
    expect(uniqueEvents(legacyEvents).find((event) => event.login === "alice")?.firstReviewedAt).toBe("2026-09-29T10:00:00Z");
    expect(uniqueEvents(eventsFromSearch(search([pr()]), "opened", week))[0]).not.toHaveProperty("firstReviewedAt");
  });
});

describe("complete pagination", () => {
  it("starts independent metric searches together and preserves complete results", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const run = (query: string) => new Promise<ReturnType<typeof response>>((resolve) => {
      started.push(query);
      releases.push(() => resolve(response(search(query.includes("created:") ? [pr()] : []))));
    });
    const result = loadActivity("parsleyhealth", week, run, new AbortController().signal);
    expect(started).toHaveLength(4);
    releases.forEach((release) => release());
    expect((await result).map((event) => event.metric)).toEqual(["opened"]);
  });
  it("bounds long GitHub titles before activity and snapshot schemas parse them", async () => {
    const longTitle = "Readable title " + "x".repeat(400);
    const longActivity = pr({ title: longTitle });
    const longSnapshot = snapshot({ title: longTitle });
    const runActivity = async (query: string) => response(search(query.includes("created:") ? [longActivity] : []));
    const activity = await loadActivity("bitcomplete", week, runActivity, new AbortController().signal);
    expect(activity[0]?.title).toBe(`${longTitle.slice(0, 299)}…`);
    expect(activity[0]?.title).toHaveLength(300);
    expect(eventsFromSearch(search([pr()]), "opened", week)[0]?.title).toBe("Improve eligibility");

    const runSnapshot = async () => response(search([longSnapshot]));
    const inProgress = await loadInProgress("bitcomplete", week, new Date("2026-09-30T12:00:00Z"), runSnapshot, new AbortController().signal);
    expect(inProgress[0]?.title).toBe(`${longTitle.slice(0, 299)}…`);
    expect(inProgress[0]?.title).toHaveLength(300);
  });
  it("follows each search cursor and includes older PR reviews from updated search", async () => {
    const seen: string[] = [];
    const older = pr({ createdAt: "2026-08-01T00:00:00Z", reviews: { pageInfo: { hasNextPage: false }, nodes: [
      { id: "old-review", submittedAt: "2026-09-30T12:00:00Z", state: "APPROVED", author: { __typename: "User", login: "reviewer" } },
    ] } });
    const run = async (query: string, cursor: string | null) => {
      seen.push(`${query}|${cursor}`);
      if (query.includes("updated:")) return response(search([older]));
      if (query.includes("created:") && cursor === null) return response(search([], 101, true, "next"));
      if (query.includes("created:") && cursor === "next") return response(search([pr()]));
      return response(search([]));
    };
    const events = await loadActivity("parsleyhealth", week, run, new AbortController().signal);
    expect(events.map((event) => event.metric)).toEqual(["reviewed", "opened"]);
    expect(seen.filter((entry) => entry.includes("created:"))).toHaveLength(2);
    expect(searchQuery("parsleyhealth", "reviewed", week)).toContain("updated:");
    expect(searchQuery("ira-cscc", "opened", week)).toContain("org:ira-cscc is:pr created:");
  });
  it("fails instead of showing totals when search or review pagination is incomplete", async () => {
    const run = async () => response(search([], 1001, true, "next"));
    await expect(loadActivity("parsleyhealth", week, run, new AbortController().signal)).rejects.toThrow("incomplete");
    const manyReviews = pr({ reviews: { pageInfo: { hasNextPage: true }, nodes: [] } });
    expect(() => eventsFromSearch(search([manyReviews]), "reviewed", week)).toThrow("incomplete");
  });
});

describe("in-progress snapshot", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  it("includes a carried-over open PR, a later close, and a draft; excludes a PR merged within the week", () => {
    const cutoff = new Date(weekBounds(week).end);
    const items = [
      snapshot({ number: 1, url: "https://github.com/parsleyhealth/sage/pull/1", createdAt: "2026-09-01T00:00:00Z" }),
      snapshot({ number: 2, url: "https://github.com/parsleyhealth/sage/pull/2", mergedAt: "2026-10-02T00:00:00Z", closedAt: "2026-10-02T00:00:00Z" }),
      snapshot({ number: 3, url: "https://github.com/parsleyhealth/sage/pull/3", closedAt: "2026-10-06T00:00:00Z" }),
      snapshot({ number: 4, url: "https://github.com/parsleyhealth/sage/pull/4", isDraft: true }),
      snapshot({ number: 5, url: "https://github.com/parsleyhealth/sage/pull/5", createdAt: "2026-10-05T04:00:00Z" }),
      snapshot({ number: 6, url: "https://github.com/parsleyhealth/sage/pull/6", author: { __typename: "Bot", login: "helper[bot]" } }),
    ];
    expect(inProgressFromSearch(search(items), cutoff).map((item) => item.number)).toEqual([1, 3, 4]);
    expect(inProgressFromSearch(search(items), cutoff).find((item) => item.number === 4)?.isDraft).toBe(true);
  });
  it("uses current open state and the fetch-time cutoff", () => {
    const items = [snapshot({ number: 1, createdAt: "2026-10-07T11:59:59Z", closedAt: "2026-10-01T00:00:00Z" }),
      snapshot({ number: 2, createdAt: "2026-10-07T12:00:00Z" })];
    expect(inProgressFromSearch(search(items), now, true).map((item) => item.number)).toEqual([1]);
    expect(inProgressQueries("parsleyhealth", "2026-10-05", now)).toEqual(["org:parsleyhealth is:pr is:open created:>=2026-07-09"]);
  });
  it("uses the ET week end as the historical snapshot cutoff", () => {
    const cutoff = new Date(weekBounds(week).end);
    const items = [
      snapshot({ number: 1, url: "https://github.com/parsleyhealth/sage/pull/1", createdAt: "2026-10-05T03:59:59Z", closedAt: "2026-10-05T04:00:00Z" }),
      snapshot({ number: 2, url: "https://github.com/parsleyhealth/sage/pull/2", createdAt: "2026-10-05T04:00:00Z" }),
      snapshot({ number: 3, url: "https://github.com/parsleyhealth/sage/pull/3", createdAt: "2026-09-30T12:00:00Z", closedAt: "2026-10-05T03:59:59Z" }),
    ];
    expect(inProgressFromSearch(search(items), cutoff).map((item) => item.number)).toEqual([1]);
  });
  it("includes the exact 90-day boundary and excludes older or post-cutoff PRs", () => {
    const cutoff = new Date("2026-10-07T12:00:00Z");
    const items = [
      snapshot({ number: 1, url: "https://github.com/parsleyhealth/sage/pull/1", createdAt: "2026-07-09T11:59:59Z" }),
      snapshot({ number: 2, url: "https://github.com/parsleyhealth/sage/pull/2", createdAt: "2026-07-09T12:00:00Z" }),
      snapshot({ number: 3, url: "https://github.com/parsleyhealth/sage/pull/3", createdAt: "2026-10-07T12:00:00Z" }),
    ];
    expect(inProgressFromSearch(search(items), cutoff, true).map((item) => item.number)).toEqual([2]);
  });
  it("paginates and deduplicates the two historical searches", async () => {
    const seen: string[] = [];
    const item = snapshot({ createdAt: "2026-09-29T00:00:00Z" });
    const run = async (query: string, cursor: string | null) => {
      seen.push(`${query}|${cursor}`);
      if (query.includes("is:open") && cursor === null) return response(search([], 101, true, "next"));
      return response(search([item]));
    };
    const result = await loadInProgress("parsleyhealth", week, now, run, new AbortController().signal);
    expect(result).toHaveLength(1);
    expect(seen).toHaveLength(3);
    expect(seen).toContainEqual(expect.stringContaining("is:open created:2026-07-07..2026-10-05|next"));
    expect(seen).toContainEqual(expect.stringContaining("is:closed closed:>=2026-10-05 created:2026-07-07..2026-10-05|null"));
  });
  it("fails clearly on incomplete search results or a future week", async () => {
    const tooMany = async () => response(search([], 1001, true, "next"));
    await expect(loadInProgress("parsleyhealth", week, now, tooMany, new AbortController().signal)).rejects.toThrow("incomplete");
    const noCursor = async () => response(search([], 100, true));
    await expect(loadInProgress("parsleyhealth", week, now, noCursor, new AbortController().signal)).rejects.toThrow("pagination stopped");
    await expect(loadInProgress("parsleyhealth", "2026-10-12", now, tooMany, new AbortController().signal)).rejects.toThrow("current week or an earlier");
  });
});
